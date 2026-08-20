import { none } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

export default eveChannel({
  // This local e2e fixture has no user accounts and only serves the test runner.
  auth: none(),
});
