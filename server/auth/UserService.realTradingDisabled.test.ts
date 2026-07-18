import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { EmailService } from "../modules/email/EmailService";
import { TradingStore } from "../storage/TradingStore";
import { UserService } from "./UserService";

test("a disabled user's revoked real-trading session resolves only to disabled/403 identity", () => {
  const directory = mkdtempSync(join(tmpdir(), "xingheng-disabled-session-"));
  const store = new TradingStore(join(directory, "test.sqlite"));
  const users = new UserService(store, {} as EmailService, "http://127.0.0.1:5173");
  const login = users.login("demo@example.com", "demo123");
  assert.equal(users.authenticate(login.token)?.status, "active");
  users.setUserStatus(login.user.id, "disabled");
  assert.equal(users.authenticate(login.token), null, "revoked session cannot authorize actions");
  assert.equal(users.authenticateIncludingDisabledRevocation(login.token)?.status, "disabled");
  users.logout(login.token);
  assert.equal(users.authenticateIncludingDisabledRevocation(login.token), null, "logout removes the tombstone");
  store.close();
  rmSync(directory, { recursive: true, force: true });
});
