/** Raised when a login/portal step does not reach the expected state. */
export class BizmekaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BizmekaError";
  }
}
