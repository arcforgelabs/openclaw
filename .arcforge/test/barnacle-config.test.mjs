// Arc Forge config on top of upstream Barnacle: disabled rules stay inert,
// enabled rules close, members/maintainers/bots stay exempt, repo overrides merge.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { run } from "../barnacle/run.mjs";
import { managedLabelSpecs } from "../vendor/openclaw/scripts/github/barnacle-auto-response.mjs";

function notFound() {
  const error = new Error("not found");
  error.status = 404;
  return error;
}

function mockGithub({ maintainers = [], override } = {}) {
  const calls = { addLabels: [], createComment: [], lock: [], removeLabel: [], update: [] };
  const github = {
    paginate: async () => [],
    rest: {
      issues: {
        addLabels: async (p) => calls.addLabels.push(p),
        createComment: async (p) => calls.createComment.push(p),
        createLabel: async () => undefined,
        getLabel: async ({ name }) => ({ data: { color: managedLabelSpecs[name]?.color ?? "C5DEF5", description: managedLabelSpecs[name]?.description ?? "" } }),
        lock: async (p) => calls.lock.push(p),
        removeLabel: async (p) => calls.removeLabel.push(p),
        update: async (p) => calls.update.push(p),
        updateLabel: async () => undefined,
      },
      pulls: { listFiles: async () => [] },
      repos: {
        getCollaboratorPermissionLevel: async () => ({ data: { permission: "read", role_name: "read" } }),
        getContent: async () => {
          if (!override) throw notFound();
          return { data: { content: Buffer.from(JSON.stringify(override)).toString("base64") } };
        },
      },
      teams: {
        getMembershipForUserInOrg: async ({ username }) => {
          if (maintainers.includes(username.toLowerCase())) return { data: { state: "active" } };
          throw notFound();
        },
      },
    },
  };
  return { calls, github };
}

function issueContext({ labels = [], action = "labeled", label, association = "NONE", login = "outsider", comment, title = "Something broke", body = "" } = {}) {
  return {
    repo: { owner: "arcforgelabs", repo: "openclaw" },
    payload: {
      action,
      label: label ? { name: label } : undefined,
      sender: { login: "IAMSamuelRodda", type: "User" },
      repository: { default_branch: "master" },
      issue: { number: 7, title, body, author_association: association, user: { login }, labels: labels.map((name) => ({ name })) },
      comment,
    },
  };
}

const core = { info: () => undefined, warning: () => undefined };

async function barnacle(context, options) {
  const { calls, github } = mockGithub(options);
  await run({ github, context, core });
  return calls;
}

describe("repository-owned Barnacle policy", () => {
  it("closes outside support with Arc Forge policy, not product defaults", async () => {
    const calls = await barnacle(issueContext({ labels: ["r: support"], label: "r: support" }));
    assert.equal(calls.createComment.length, 1);
    assert.match(calls.createComment[0].body, /Arc Forge support/);
    assert.doesNotMatch(calls.createComment[0].body, /discord|clawhub|openclaw/i);
    assert.equal(calls.update[0]?.state, "closed");
  });
  it("keeps disabled product rules, maintainers and members inert", async () => {
    for (const [context, options] of [
      [issueContext({ labels: ["r: skill"], label: "r: skill" })],
      [issueContext({ labels: ["r: support"], label: "r: support", login: "maintainer" }), { maintainers: ["maintainer"] }],
      [issueContext({ labels: ["r: support"], label: "r: support", association: "MEMBER" })],
    ]) {
      const calls = await barnacle(context, options);
      assert.deepEqual(calls.createComment, []);
      assert.deepEqual(calls.update, []);
    }
  });
});
