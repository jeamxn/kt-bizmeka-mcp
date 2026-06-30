/** Raised when a login/portal step does not reach the expected state. */
export class BizmekaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BizmekaError";
  }
}

/**
 * Signals that the remembered browser is already authenticated, so loginForm.do
 * redirected to ssoLogin.do instead of serving a fresh form. Callers treat this
 * as a successful no-SMS login rather than an error.
 */
export class AlreadyLoggedInError extends BizmekaError {
  constructor() {
    super("already logged in (trusted browser); no credentials needed");
    this.name = "AlreadyLoggedInError";
  }
}
