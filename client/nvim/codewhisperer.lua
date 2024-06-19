local util = require 'lspconfig.util'
local json = require("json")

local root_files = {
  '.git',
  'test_dexp_root',
}

-- Function to read and parse the JSON file
function getToken(filePath)
  local filePath = "/Users/vshcherb/.aws/sso/cache/bc71d4deb418055c4c3a53626b82956e64fbfdc2.json"
  local file = io.open(filePath, "r")
  if file then
      local contents = file:read("*a")
      file:close()

      -- Parse the JSON string using the built-in load function
      local data = json:decode(contents)
      if not data then
          return nil
      end

      if data.accessToken then
          -- print("Access Token: " .. data.accessToken)
          return data.accessToken
      else
          return nil, data
      end
  else
      return nil, "Error opening file: " .. filePath
  end
end

local function q_sso_access_token()
  local accessToken = getToken(filePath)

  local params = {
    data = {
      token = accessToken
    },
  }

  local bufnr = vim.api.nvim_get_current_buf()
  local cwspr_client = util.get_active_client_by_name(bufnr, 'dexpcwspr')

  print('Sending bearer token to server')
  cwspr_client.request('aws/credentials/token/update', params, function(err, result)
    if err then
      error(tostring(err))
    end
    print('Bearer token was sent to server')
  end, bufnr)
end

local function security_scan_command()
  local bufnr = vim.api.nvim_get_current_buf()
  local cwspr_client = util.get_active_client_by_name(bufnr, 'dexpcwspr')

  local params = {
    command = 'aws/codewhisperer/runSecurityScan',
    arguments = {
      {
        ActiveFilePath = vim.api.nvim_buf_get_name(bufnr),
        ProjectPath = cwspr_client.config.root_dir,
      }
    }
  }
  
  print('Sending Run Security Scan command')
  cwspr_client.request('workspace/executeCommand', params, nil, bufnr)
end

return {
  default_config = {
    cmd = { 'node', '/Users/vshcherb/Projects/DEXP/language-servers/app/aws-lsp-codewhisperer-binary/out/aws-lsp-codewhisperer-binary.js', '--stdio' },
    filetypes = { 'python', 'typescript', 'json', 'javascript', 'cs' },
    root_dir = function(fname)
      return util.root_pattern(unpack(root_files))(fname)
    end,
    single_file_support = true,
    settings = {
    },
  },
  commands = {
    GetAccessToken = {
      q_sso_access_token,
      description = 'Codewhisperer - grab SSO token from AWS Toolkit (for Demo)',
    },
    RunQSecurityScan = {
      security_scan_command,
      description = 'Codewhisperer - PoC for security scan command in NeoVim',
    },
  },
  docs = {
    description = [[Test DEXP Codewhisperer]],
  },
}
