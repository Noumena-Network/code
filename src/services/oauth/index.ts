import { logEvent } from 'src/services/analytics/index.js'
import { openBrowser } from '../../utils/browser.js'
import { logForDebugging } from '../../utils/debug.js'
import { AuthCodeListener } from './auth-code-listener.js'
import * as client from './client.js'
import * as crypto from './crypto.js'
import type {
  OAuthProfileResponse,
  OAuthTokenExchangeResponse,
  OAuthTokens,
  RateLimitTier,
  SubscriptionType,
} from './types.js'

const CALLBACK_RELAY_REGISTRATION_ATTEMPTS = 3
const CALLBACK_RELAY_REGISTRATION_TIMEOUT_MS = 1000
const CALLBACK_RELAY_POLL_INTERVAL_MS = 250
const LOGIN_PROFILE_FETCH_TIMEOUT_MS = 1000

function oauthErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * OAuth service that handles the OAuth 2.0 authorization code flow with PKCE.
 *
 * Supports two ways to get authorization codes:
 * 1. Automatic: Opens browser, redirects to localhost where we capture the code
 * 2. Manual: User manually copies and pastes the code (used in non-browser environments)
 */
export class OAuthService {
  private codeVerifier: string
  private authCodeListener: AuthCodeListener | null = null
  private port: number | null = null
  private manualAuthCodeResolver: ((authorizationCode: string) => void) | null =
    null
  private relayPollingCancelled = false

  constructor() {
    this.codeVerifier = crypto.generateCodeVerifier()
  }

  async startOAuthFlow(
    authURLHandler: (url: string, automaticUrl?: string) => Promise<void>,
    options?: {
      loginWithClaudeAi?: boolean
      inferenceOnly?: boolean
      expiresIn?: number
      orgUUID?: string
      loginHint?: string
      loginMethod?: string
      /**
       * Don't call openBrowser(). Caller takes both URLs via authURLHandler
       * and decides how/where to open them. Used by the SDK control protocol
       * (claude_authenticate) where the SDK client owns the user's display,
       * not this process.
       */
      skipBrowserOpen?: boolean
    },
  ): Promise<OAuthTokens> {
    // Create OAuth callback listener and start it
    this.authCodeListener = new AuthCodeListener()
    this.port = await this.authCodeListener.start()

    // Generate PKCE values and state
    const codeChallenge = crypto.generateCodeChallenge(this.codeVerifier)
    const state = crypto.generateState()
    const manualRelayId = crypto.generateState()
    await this.registerCallbackRelayOrThrow(manualRelayId, state)

    // Build auth URLs for both automatic and manual flows
    const opts = {
      codeChallenge,
      state,
      port: this.port,
      manualRelayId,
      loginWithClaudeAi: options?.loginWithClaudeAi,
      inferenceOnly: options?.inferenceOnly,
      orgUUID: options?.orgUUID,
      loginHint: options?.loginHint,
      loginMethod: options?.loginMethod,
    }
    const manualFlowUrl = client.buildAuthUrl({ ...opts, isManual: true })
    const automaticFlowUrl = client.buildAuthUrl({ ...opts, isManual: false })
    const manualRedirectUri =
      new URL(manualFlowUrl).searchParams.get('redirect_uri') ?? undefined

    // Wait for either automatic or manual auth code
    this.relayPollingCancelled = false
    const authorizationCode = await this.waitForAuthorizationCode(
      state,
      async () => {
        if (options?.skipBrowserOpen) {
          // Hand both URLs to the caller. The automatic one still works
          // if the caller opens it on the same host (localhost listener
          // is running); the manual one works from anywhere.
          await authURLHandler(manualFlowUrl, automaticFlowUrl)
        } else {
          await authURLHandler(manualFlowUrl) // Show manual option to user
          await openBrowser(automaticFlowUrl) // Try automatic flow
        }
      },
      manualRelayId,
    )

    // Check if the automatic flow is still active (has a pending response)
    const isAutomaticFlow = this.authCodeListener?.hasPendingResponse() ?? false
    logEvent('ncode_oauth_auth_code_received', { automatic: isAutomaticFlow })

    try {
      // Exchange authorization code for tokens
      const tokenResponse = await client.exchangeCodeForTokens(
        authorizationCode,
        state,
        this.codeVerifier,
        this.port!,
        !isAutomaticFlow, // Pass isManual=true if it's NOT automatic flow
        options?.expiresIn,
        !isAutomaticFlow ? manualRedirectUri : undefined,
      )

      // Fetch profile info (subscription type and rate limit tier) for the
      // returned OAuthTokens. Logout and account storage are handled by the
      // caller (installOAuthTokens in auth.ts).
      const profileInfo = await client.fetchProfileInfo(
        tokenResponse.access_token,
        LOGIN_PROFILE_FETCH_TIMEOUT_MS,
      ).catch(error => {
        logForDebugging(
          `OAuth profile enrichment skipped during login: ${oauthErrorMessage(error)}`,
        )
        return null
      })

      // Handle success redirect for automatic flow
      if (isAutomaticFlow) {
        const scopes = client.parseScopes(tokenResponse.scope)
        this.authCodeListener?.handleSuccessRedirect(scopes)
      }

      return this.formatTokens(
        tokenResponse,
        profileInfo?.subscriptionType ?? null,
        profileInfo?.rateLimitTier ?? null,
        profileInfo?.rawProfile,
      )
    } catch (error) {
      // If we have a pending response, send an error redirect before closing
      if (isAutomaticFlow) {
        this.authCodeListener?.handleErrorRedirect()
      }
      throw error
    } finally {
      // Always cleanup
      this.authCodeListener?.close()
    }
  }

  private async registerCallbackRelayOrThrow(
    relayId: string,
    state: string,
  ): Promise<void> {
    let lastError: unknown
    for (let attempt = 1; attempt <= CALLBACK_RELAY_REGISTRATION_ATTEMPTS; attempt += 1) {
      try {
        await client.registerOauthCallbackRelay({
          relayId,
          state,
          timeoutMs: CALLBACK_RELAY_REGISTRATION_TIMEOUT_MS,
        })
        if (attempt > 1) {
          logForDebugging(
            `OAuth callback relay registration recovered on attempt ${attempt}`,
          )
        }
        return
      } catch (error) {
        lastError = error
        logForDebugging(
          `OAuth callback relay registration attempt ${attempt} failed: ${oauthErrorMessage(error)}`,
        )
        if (attempt < CALLBACK_RELAY_REGISTRATION_ATTEMPTS) {
          await delay(150 * attempt)
        }
      }
    }

    throw new Error(
      `OAuth callback relay registration failed after ${CALLBACK_RELAY_REGISTRATION_ATTEMPTS} attempts: ${oauthErrorMessage(lastError)}`,
    )
  }

  private async waitForAuthorizationCode(
    state: string,
    onReady: () => Promise<void>,
    manualRelayId?: string,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      let settled = false
      const resolveOnce = (authorizationCode: string) => {
        if (settled) {
          return
        }
        settled = true
        this.manualAuthCodeResolver = null
        resolve(authorizationCode)
      }
      const rejectOnce = (error: Error) => {
        if (settled) {
          return
        }
        settled = true
        this.manualAuthCodeResolver = null
        reject(error)
      }

      // Set up manual auth code resolver
      this.manualAuthCodeResolver = resolveOnce

      // Start automatic flow
      this.authCodeListener
        ?.waitForAuthorization(state, onReady)
        .then(authorizationCode => {
          resolveOnce(authorizationCode)
        })
        .catch(error => {
          rejectOnce(error)
        })

      if (manualRelayId) {
        void this.waitForRelayAuthorizationCode(manualRelayId)
          .then(authorizationCode => {
            resolveOnce(authorizationCode)
          })
          .catch(error => {
            if (!this.relayPollingCancelled) {
              rejectOnce(error)
            }
          })
      }
    })
  }

  private async waitForRelayAuthorizationCode(
    relayId: string,
  ): Promise<string> {
    for (;;) {
      if (this.relayPollingCancelled) {
        throw new Error('OAuth callback relay polling cancelled')
      }
      const authorizationCode = await client.pollOauthCallbackRelay(relayId)
      if (authorizationCode) {
        logEvent('ncode_oauth_callback_relay_success', {})
        return authorizationCode
      }
      await delay(CALLBACK_RELAY_POLL_INTERVAL_MS)
    }
  }

  // Handle manual flow callback when user pastes the auth code
  handleManualAuthCodeInput(params: {
    authorizationCode: string
    state: string
  }): void {
    if (this.manualAuthCodeResolver) {
      this.manualAuthCodeResolver(params.authorizationCode)
      this.manualAuthCodeResolver = null
      // Close the auth code listener since manual input was used
      this.authCodeListener?.close()
    }
  }

  private formatTokens(
    response: OAuthTokenExchangeResponse,
    subscriptionType: SubscriptionType | null,
    rateLimitTier: RateLimitTier | null,
    profile?: OAuthProfileResponse,
  ): OAuthTokens {
    return {
      accessToken: response.access_token,
      refreshToken: response.refresh_token,
      expiresAt: Date.now() + response.expires_in * 1000,
      scopes: client.parseScopes(response.scope),
      subscriptionType,
      rateLimitTier,
      profile,
      tokenAccount: response.account
        ? {
            uuid: response.account.uuid,
            emailAddress: response.account.email_address,
            organizationUuid: response.organization?.uuid,
          }
        : undefined,
    }
  }

  // Clean up any resources (like the local server)
  cleanup(): void {
    this.relayPollingCancelled = true
    this.authCodeListener?.close()
    this.manualAuthCodeResolver = null
  }
}
