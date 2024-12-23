import {
    AwsBuilderIdSsoTokenSource,
    AwsErrorCodes,
    CancellationToken,
    getSsoTokenOptionsDefaults,
    GetSsoTokenParams,
    GetSsoTokenResult,
    IamIdentityCenterSsoTokenSource,
    InvalidateSsoTokenParams,
    InvalidateSsoTokenResult,
    SsoSession,
    SsoTokenSourceKind,
} from '@aws/language-server-runtimes/server-interface'
import { ProfileStore } from './profiles/profileService'
import { authorizationCodePkceFlow, awsBuilderIdReservedName, awsBuilderIdSsoRegion, ShowUrl } from '../sso'
import { AwsError } from '../awsError'
import { SsoCache } from '../sso/cache'
import { SsoTokenAutoRefresher } from './ssoTokenAutoRefresher'
import { throwOnInvalidClientRegistration, throwOnInvalidSsoSession, throwOnInvalidSsoSessionName } from '../sso/utils'
import { Observability } from './utils'

type SsoTokenSource = IamIdentityCenterSsoTokenSource | AwsBuilderIdSsoTokenSource

export class IdentityService {
    constructor(
        private readonly profileStore: ProfileStore,
        private readonly ssoCache: SsoCache,
        private readonly autoRefresher: SsoTokenAutoRefresher,
        private readonly showUrl: ShowUrl,
        private readonly clientName: string,
        private readonly observability: Observability
    ) {}

    async getSsoToken(params: GetSsoTokenParams, token: CancellationToken): Promise<GetSsoTokenResult> {
        const options = { ...getSsoTokenOptionsDefaults, ...params.options }

        token.onCancellationRequested(_ => {
            if (options.loginOnInvalidToken) {
                this.observability.telemetry.emitMetric({
                    name: 'auth_addConnection',
                    result: 'Cancelled',
                })
            }
        })

        const ssoSession = await this.getSsoSession(params.source)
        throwOnInvalidSsoSession(ssoSession)

        let ssoToken = await this.ssoCache.getSsoToken(this.clientName, ssoSession)

        if (!ssoToken) {
            // If no cached token and cannot start the login process, give up
            if (!options.loginOnInvalidToken) {
                this.observability.logging.log(
                    'SSO token not found an loginOnInvalidToken = false, returning no token.'
                )
                throw new AwsError('SSO token not found.', AwsErrorCodes.E_INVALID_SSO_TOKEN)
            }

            const clientRegistration = await this.ssoCache.getSsoClientRegistration(this.clientName, ssoSession)
            throwOnInvalidClientRegistration(clientRegistration)

            ssoToken = await authorizationCodePkceFlow(
                this.clientName,
                clientRegistration,
                ssoSession,
                this.showUrl,
                token,
                this.observability
            ).catch(reason => {
                const awsError = AwsError.wrap(reason, AwsErrorCodes.E_CANNOT_CREATE_SSO_TOKEN)
                // Consider using PII scrubbing such as:
                // https://github.com/justinmk3/aws-toolkit-vscode/blob/ea74f2f04554b7bb75831f0a0d2c60fdb5ca2820/packages/core/src/shared/errors.ts#L323
                this.observability.telemetry.emitMetric({
                    name: 'auth_addConnection',
                    errorData: {
                        reason: awsError.message,
                        errorCode: awsError.awsErrorCode,
                    },
                    result: 'Failed',
                })
                throw awsError
            })

            this.observability.telemetry.emitMetric({
                name: 'auth_addConnection',
                data: { reason: 'User logged in successfully' },
                result: 'Succeeded',
            })

            await this.ssoCache.setSsoToken(this.clientName, ssoSession, ssoToken!).catch(reason => {
                throw AwsError.wrap(reason, AwsErrorCodes.E_CANNOT_WRITE_SSO_CACHE)
            })
        }

        // Auto refresh is best effort
        await this.autoRefresher.watch(this.clientName, ssoSession).catch(reason => {
            this.observability.logging.log(`Unable to auto-refresh token. ${reason}`)
        })

        this.observability.logging.log('Successfully retrieved existing or newly authenticated SSO token.')
        return {
            ssoToken: { accessToken: ssoToken.accessToken, id: ssoSession.name },
            updateCredentialsParams: { data: { token: ssoToken.accessToken }, encrypted: false },
        }
    }

    async invalidateSsoToken(
        params: InvalidateSsoTokenParams,
        token: CancellationToken
    ): Promise<InvalidateSsoTokenResult> {
        throwOnInvalidSsoSessionName(params?.ssoTokenId)

        this.autoRefresher.unwatch(params.ssoTokenId)

        await this.ssoCache.removeSsoToken(params.ssoTokenId)

        this.observability.logging.log('Successfully invalidated SSO token.')
        return {}
    }

    private async getSsoSession(source: SsoTokenSource): Promise<SsoSession> {
        switch (source.kind) {
            case SsoTokenSourceKind.AwsBuilderId:
                return {
                    name: awsBuilderIdReservedName,
                    settings: {
                        sso_region: awsBuilderIdSsoRegion,
                        sso_registration_scopes: source.ssoRegistrationScopes,
                        sso_start_url: 'https://view.awsapps.com/start',
                    },
                }
            case SsoTokenSourceKind.IamIdentityCenter:
                return await this.getSsoSessionFromProfileStore(source)
            default:
                this.observability.logging.log(`SSO token source [${source['kind']}] is not supported.`)
                throw new AwsError(
                    `SSO token source [${source['kind']}] is not supported.`,
                    AwsErrorCodes.E_SSO_TOKEN_SOURCE_NOT_SUPPORTED
                )
        }
    }

    private async getSsoSessionFromProfileStore(source: IamIdentityCenterSsoTokenSource): Promise<SsoSession> {
        const profileData = await this.profileStore.load()

        const profile = profileData.profiles.find(profile => profile.name === source.profileName)
        if (!profile) {
            this.observability.logging.log('Profile not found.')
            throw new AwsError('Profile not found.', AwsErrorCodes.E_PROFILE_NOT_FOUND)
        }

        const ssoSession = profileData.ssoSessions.find(ssoSession => ssoSession.name === profile.settings?.sso_session)
        if (!ssoSession) {
            this.observability.logging.log('SSO session not found.')
            throw new AwsError('SSO session not found.', AwsErrorCodes.E_SSO_SESSION_NOT_FOUND)
        }

        // eslint-disable-next-line no-extra-semi
        ;(ssoSession.settings ||= {}).sso_registration_scopes = ssoSession.settings.sso_registration_scopes

        return ssoSession
    }
}
