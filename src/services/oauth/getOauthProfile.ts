import { OAUTH_BETA_HEADER } from 'src/constants/oauth.js'
import { getAuthRuntime } from 'src/auth/runtime/AuthRuntime.js'
import type { OAuthProfileResponse } from 'src/services/oauth/types.js'
import { logError } from 'src/utils/log.js'
import { getIdentityClient } from './identityClient.js'
export async function getOauthProfileFromApiKey(): Promise<
  OAuthProfileResponse | undefined
> {
  const session = getAuthRuntime().getCurrentSession()
  const accountUuid = session.identity.accountUuid
  const apiKey = session.hasUsableApiKey ? session.apiKey : null

  // Need both account UUID and API key to check
  if (!accountUuid || !apiKey) {
    return
  }
  try {
    return await getIdentityClient().getOauthProfileFromApiKey({
      apiKey,
      accountUuid,
      betaHeader: OAUTH_BETA_HEADER,
      timeout: 10000,
    })
  } catch (error) {
    logError(error as Error)
  }
}

export async function getOauthProfileFromOauthToken(
  accessToken: string,
  timeout = 10000,
): Promise<OAuthProfileResponse | undefined> {
  try {
    return await getIdentityClient().getOauthProfileFromOauthToken({
      accessToken,
      timeout,
    })
  } catch (error) {
    logError(error as Error)
  }
}
