// Cognito login utility for testing
//
// Typically called

import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserPool,
} from "amazon-cognito-identity-js";

export async function loginCognito({
  poolId,
  clientId,
  username,
  password,
  label = "Primary account",
}) {
  if (!poolId || !clientId || !username || !password)
    throw new Error(
      `${label}: Cognito pool, client, username and password are required.`,
    );
  const data = new Map();
  const storage = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: (key) => data.delete(key),
    clear: () => data.clear(),
  };

  try {
    const pool = new CognitoUserPool({
      UserPoolId: poolId,
      ClientId: clientId,
      Storage: storage,
    });

    // Bound the complete SRP exchange; the SDK transport passes these options to fetch.
    pool.client.fetchOptions.signal = AbortSignal.timeout(30_000);
    const user = new CognitoUser({
      Username: username,
      Pool: pool,
      Storage: storage,
    });

    user.setAuthenticationFlowType("USER_SRP_AUTH");

    return await new Promise((resolve, reject) => {
      const challenge = (name) =>
        reject(
          new Error(
            `${label}: ${name} requires interactive account setup; complete it before running this test.`,
          ),
        );

      user.authenticateUser(
        new AuthenticationDetails({ Username: username, Password: password }),
        {
          onSuccess: (session) => {
            const token = session.getIdToken();
            if (!token.getJwtToken() || !token.payload.sub)
              return reject(
                new Error(`${label}: login returned no usable ID token.`),
              );
            resolve({ idToken: token.getJwtToken(), sub: token.payload.sub });
          },
          onFailure: (error) => {
            const code = /^[A-Za-z]+$/.test(error.name ?? "")
              ? error.name
              : "AuthenticationError";

            reject(
              new Error(
                `${label}: Cognito login failed (${code}). Check credentials, confirmation status and client configuration.`,
              ),
            );
          },
          newPasswordRequired: () => challenge("Password change"),
          mfaRequired: () => challenge("SMS MFA"),
          totpRequired: () => challenge("TOTP MFA"),
          mfaSetup: () => challenge("MFA setup"),
          selectMFAType: () => challenge("MFA selection"),
          customChallenge: () => challenge("Custom authentication"),
        },
      );
    });
  } finally {
    storage.clear();
  }
}
