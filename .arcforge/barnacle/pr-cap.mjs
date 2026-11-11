// Upstream's PR cap: the "Apply too-many-prs label" step of openclaw's
// labeler workflow (vendor/openclaw/.github/workflows/labeler.yml), moved into
// a module unchanged except that the limit, team slug and automation head
// prefixes come from barnacle/config.json and the label-cap helper is imported
// statically. Barnacle's `r: too-many-prs` rule does the closing.
import { addLabelsWithinCap } from "../../scripts/github/labeler-label-cap.mjs";

export async function applyPrCap({ github, context, core }, config = {}) {
  const pullRequest = context.payload.pull_request;
  if (!pullRequest) {
    return;
  }

  const activePrLimitLabel = "r: too-many-prs";
  const activePrLimitOverrideLabel = "r: too-many-prs-override";
  const activePrLimit = Number(config.activePrLimit ?? 20);
  const labelColor = "B60205";
  const labelDescription = `Author has more than ${activePrLimit} active PRs in this repo`;
  const authorLogin = pullRequest.user?.login;
  const headRefName = pullRequest.head?.ref ?? "";
  if (!authorLogin) {
    return;
  }

  const currentLabels = await github.paginate(github.rest.issues.listLabelsOnIssue, {
    owner: context.repo.owner,
    repo: context.repo.repo,
    issue_number: pullRequest.number,
    per_page: 100,
  });

  const labelNames = new Set(
    currentLabels
      .map((label) => (typeof label === "string" ? label : label?.name))
      .filter((name) => typeof name === "string"),
  );

  if (pullRequest.user?.type === "Bot" || /\[bot\]$/i.test(authorLogin) || authorLogin.startsWith("app/")) {
    if (labelNames.has(activePrLimitLabel)) {
      try {
        await github.rest.issues.removeLabel({
          owner: context.repo.owner,
          repo: context.repo.repo,
          issue_number: pullRequest.number,
          name: activePrLimitLabel,
        });
      } catch (error) {
        if (error?.status !== 404) {
          throw error;
        }
      }
    }
    core.info(`Skipping active PR limit for GitHub App author ${authorLogin}.`);
    return;
  }

  if (labelNames.has(activePrLimitOverrideLabel)) {
    if (labelNames.has(activePrLimitLabel)) {
      try {
        await github.rest.issues.removeLabel({
          owner: context.repo.owner,
          repo: context.repo.repo,
          issue_number: pullRequest.number,
          name: activePrLimitLabel,
        });
      } catch (error) {
        if (error?.status !== 404) {
          throw error;
        }
      }
    }
    return;
  }

  const ensureLabelExists = async () => {
    try {
      await github.rest.issues.getLabel({
        owner: context.repo.owner,
        repo: context.repo.repo,
        name: activePrLimitLabel,
      });
    } catch (error) {
      if (error?.status !== 404) {
        throw error;
      }
      await github.rest.issues.createLabel({
        owner: context.repo.owner,
        repo: context.repo.repo,
        name: activePrLimitLabel,
        color: labelColor,
        description: labelDescription,
      });
    }
  };

  const isPrivilegedAuthor = async () => {
    if (pullRequest.author_association === "OWNER") {
      return true;
    }

    let isMaintainer = false;
    try {
      const membership = await github.rest.teams.getMembershipForUserInOrg({
        org: context.repo.owner,
        team_slug: config.maintainerTeam ?? "maintainer",
        username: authorLogin,
      });
      isMaintainer = membership?.data?.state === "active";
    } catch (error) {
      if (error?.status !== 404) {
        throw error;
      }
    }

    if (isMaintainer) {
      return true;
    }

    try {
      const permission = await github.rest.repos.getCollaboratorPermissionLevel({
        owner: context.repo.owner,
        repo: context.repo.repo,
        username: authorLogin,
      });
      const roleName = (permission?.data?.role_name ?? "").toLowerCase();
      return roleName === "admin" || roleName === "maintain";
    } catch (error) {
      if (error?.status !== 404) {
        throw error;
      }
    }

    return false;
  };

  const automationPrHeadPrefixes = config.automationPrHeadPrefixes ?? ["clawsweeper/"];
  const isAutomationPullRequest =
    typeof headRefName === "string" &&
    automationPrHeadPrefixes.some((prefix) => headRefName.startsWith(prefix));

  if ((await isPrivilegedAuthor()) || isAutomationPullRequest) {
    if (labelNames.has(activePrLimitLabel)) {
      try {
        await github.rest.issues.removeLabel({
          owner: context.repo.owner,
          repo: context.repo.repo,
          issue_number: pullRequest.number,
          name: activePrLimitLabel,
        });
      } catch (error) {
        if (error?.status !== 404) {
          throw error;
        }
      }
    }
    return;
  }

  let openPrCount = 0;
  try {
    const result = await github.rest.search.issuesAndPullRequests({
      q: `repo:${context.repo.owner}/${context.repo.repo} is:pr is:open author:${authorLogin}`,
      per_page: 1,
    });
    openPrCount = result?.data?.total_count ?? 0;
  } catch (error) {
    if (error?.status !== 422) {
      throw error;
    }
    core.warning(`Skipping open PR count for ${authorLogin}; treating as 0.`);
  }

  if (openPrCount > activePrLimit) {
    await ensureLabelExists();
    if (!labelNames.has(activePrLimitLabel)) {
      await addLabelsWithinCap({
        github,
        core,
        owner: context.repo.owner,
        repo: context.repo.repo,
        issueNumber: pullRequest.number,
        labels: [activePrLimitLabel],
      });
    }
    return;
  }

  if (labelNames.has(activePrLimitLabel)) {
    try {
      await github.rest.issues.removeLabel({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: pullRequest.number,
        name: activePrLimitLabel,
      });
    } catch (error) {
      if (error?.status !== 404) {
        throw error;
      }
    }
  }
}
