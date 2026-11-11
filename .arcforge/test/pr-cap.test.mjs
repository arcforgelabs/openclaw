// Upstream PR cap with Arc Forge config: label over the limit, exempt
// maintainers and automation branches, honour the override label.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyPrCap } from "../barnacle/pr-cap.mjs";
import { runPrCap } from "../barnacle/run.mjs";

function notFound() {
  const error = new Error("not found");
  error.status = 404;
  return error;
}

function setup({ labels = [], openPrs = 21, maintainers = [], head = "feature/x", association = "NONE" } = {}) {
  const calls = { addLabels: [], removeLabel: [] };
  const github = {
    paginate: async () => labels.map((name) => ({ name })),
    rest: {
      issues: {
        listLabelsOnIssue: () => undefined,
        addLabels: async (p) => calls.addLabels.push(p),
        removeLabel: async (p) => calls.removeLabel.push(p),
        getLabel: async () => ({ data: {} }),
        createLabel: async () => undefined,
      },
      teams: {
        getMembershipForUserInOrg: async ({ username }) => {
          if (maintainers.includes(username)) return { data: { state: "active" } };
          throw notFound();
        },
      },
      repos: {
        getCollaboratorPermissionLevel: async () => ({ data: { role_name: "read" } }),
        getContent: async () => { throw notFound(); },
      },
      search: { issuesAndPullRequests: async () => ({ data: { total_count: openPrs } }) },
    },
  };
  const context = {
    repo: { owner: "arcforgelabs", repo: "dictate" },
    payload: {
      pull_request: {
        number: 9,
        author_association: association,
        user: { login: "outsider" },
        head: { ref: head },
        labels: labels.map((name) => ({ name })),
      },
    },
  };
  const input = { github, context, core: { warning: () => undefined, info: () => undefined } };
  return {
    calls,
    run: () => applyPrCap(input, { activePrLimit: 20, maintainerTeam: "maintainer" }),
    runConfigured: () => runPrCap(input),
  };
}

describe("PR cap", () => {
  for (const [head, capped] of [["clownfish/retired-fix", true], ["clawsweeper/current-fix", false]]) {
    it("preserves retirement policy for " + head, async () => {
      const { calls, runConfigured } = setup({ head });
      await runConfigured();
      assert.deepEqual(calls.addLabels.map((c) => c.labels), capped ? [["r: too-many-prs"]] : []);
    });
  }
  it("preserves limit, maintainers, members and explicit override", async () => {
    for (const options of [{ openPrs: 20 }, { maintainers: ["outsider"] }, { association: "OWNER" }, { labels: ["r: too-many-prs", "r: too-many-prs-override"] }]) {
      const { calls, runConfigured } = setup(options);
      await runConfigured();
      assert.deepEqual(calls.addLabels, []);
    }
  });
});
