import { afterEach, expect, test, vi } from "vitest";
import { CognitoUser } from "amazon-cognito-identity-js";
import { loginCognito } from "./cognito-login.mjs";
const options = {
  poolId: "eu-west-2_example",
  clientId: "client",
  username: "user",
  password: "secret",
};

afterEach(() => vi.restoreAllMocks());
test("SRP login returns an ID token and uses isolated ephemeral storage", async () => {
  const users = [];
  vi.spyOn(CognitoUser.prototype, "authenticateUser").mockImplementation(
    function (details, callbacks) {
      expect(this.authenticationFlowType).toBe("USER_SRP_AUTH");
      expect(details.getPassword()).toBe("secret");
      users.push(this);
      this.storage.setItem("token", "in-memory");
      callbacks.onSuccess({
        getIdToken: () => ({
          getJwtToken: () => "id-token",
          payload: { sub: "sub" },
        }),
      });
    },
  );

  expect(await loginCognito(options)).toEqual({
    idToken: "id-token",
    sub: "sub",
  });

  await loginCognito(options);
  expect(users[0].storage).not.toBe(users[1].storage);
  expect(users[0].storage.getItem("token")).toBeNull();
});

for (const callback of [
  "newPasswordRequired",
  "mfaRequired",
  "totpRequired",
  "mfaSetup",
  "selectMFAType",
  "customChallenge",
])
  test(`reports unsupported challenge ${callback}`, async () => {
    vi.spyOn(CognitoUser.prototype, "authenticateUser").mockImplementation(
      (_details, callbacks) => callbacks[callback](),
    );

    await expect(loginCognito(options)).rejects.toThrow(
      "requires interactive account setup",
    );
  });
test("login errors do not echo service messages containing credentials", async () => {
  vi.spyOn(CognitoUser.prototype, "authenticateUser").mockImplementation(
    (_details, callbacks) =>
      callbacks.onFailure({
        name: "NotAuthorizedException",
        message: "secret user password",
      }),
  );

  await expect(loginCognito(options)).rejects.toThrow("NotAuthorizedException");
  await expect(loginCognito(options)).rejects.not.toThrow(
    "secret user password",
  );
});

test("missing credentials fail before calling Cognito", async () => {
  const authenticate = vi.spyOn(CognitoUser.prototype, "authenticateUser");
  await expect(loginCognito({ ...options, password: "" })).rejects.toThrow(
    "required",
  );

  expect(authenticate).not.toHaveBeenCalled();
});
