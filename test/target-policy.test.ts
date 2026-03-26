import test from "node:test";
import assert from "node:assert/strict";
import { resolveTarget } from "../src/domain/target-policy";
import { PublishPolicy } from "../src/types";

const defaultPolicy: PublishPolicy = {
  allowContainerHostnames: true,
  allowedHosts: [],
  allowedPortRanges: [{ start: 1, end: 65535 }]
};

test("resolveTarget rewrites localhost to host.docker.internal", () => {
  const resolved = resolveTarget("http://localhost:3000", defaultPolicy);

  assert.equal(resolved.hostname, "host.docker.internal");
  assert.equal(resolved.resolvedTarget, "http://host.docker.internal:3000");
});

test("resolveTarget accepts same-network container hostnames", () => {
  const resolved = resolveTarget("http://myapp:8080", defaultPolicy);

  assert.equal(resolved.hostname, "myapp");
  assert.equal(resolved.port, 8080);
});

test("resolveTarget rejects public hosts", () => {
  assert.throws(
    () => resolveTarget("https://example.com", defaultPolicy),
    /is not allowed/
  );
});

test("resolveTarget rejects path-based targets", () => {
  assert.throws(
    () => resolveTarget("http://localhost:3000/health", defaultPolicy),
    /origin-only/
  );
});
