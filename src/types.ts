export interface UsageWindow {
  windowMinutes: number
  usedPercent: number
  resetAtMs: number
}

export interface AccountUsage {
  fetchedAt: number
  planType?: string
  windows: UsageWindow[]
}

export interface Account {
  id: string
  email?: string
  label?: string
  refresh: string
  access: string
  expires: number
  addedAt: number
  lastUsedAt?: number
  rateLimitUntilMs?: number
  usage?: AccountUsage
}

export interface Store {
  version: 1
  active?: string
  accounts: Account[]
}

export interface TokenResponse {
  id_token?: string
  access_token: string
  refresh_token: string
  expires_in?: number
}

export interface IdTokenClaims {
  chatgpt_account_id?: string
  organizations?: Array<{ id: string }>
  email?: string
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string
    user_email?: string
    chatgpt_plan_type?: string
  }
}
