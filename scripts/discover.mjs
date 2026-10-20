import { chromium } from "playwright";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";

const candidatesPath = new URL("../data/candidates.json", import.meta.url);
const outputPath = new URL("../data/review-queue.json", import.meta.url);
const candidates = JSON.parse(await readFile(candidatesPath, "utf8"));
const maxPagesPerFacility = 8;
const maxLinkDepth = 1;
const requestDelayMs = 1200;
const textLimit = 30_000;
const crawlerUserAgent = "UKMicroscopyFacilitiesPilot";
const relevantLinkPattern =
  /equipment|instrument|microscop|imaging|technique|contact|find.?us|location|address|team|people|facility/i;
const priorityLinkPattern =
  /equipment|instrument|microscop|light.?microscopy|imaging|contact|find.?us|location|address|team|people/i;
const ignoredFilePattern = /\.(?:pdf|png|jpe?g|gif|svg|webp|zip|docx?|xlsx?|pptx?)(?:$|[?#])/i;

function canonicalizeUrl(value) {
  const url = new URL(value);
  url.hash = "";
  return url.href;
}

function parseRobotsRules(content) {
  const groups = [];
  let group = null;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.split("#", 1)[0].trim();
    if (!line) continue;

    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const directive = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (directive === "user-agent") {
      if (!group || group.rules.length) {
        group = { agents: [], rules: [] };
        groups.push(group);
      }
      group.agents.push(value.toLowerCase());
    } else if ((directive === "allow" || directive === "disallow") && group && value) {
      group.rules.push({ directive, value });
    }
  }

  const exactGroups = groups.filter(({ agents }) =>
    agents.some((agent) => agent !== "*" && crawlerUserAgent.toLowerCase().includes(agent)),
  );
  const selectedGroups = exactGroups.length
    ? exactGroups
    : groups.filter(({ agents }) => agents.includes("*"));
  return selectedGroups.flatMap(({ rules }) => rules);
}

function isAllowedByRobots(urlValue, policy) {
  if (!policy.available) return false;
  const url = new URL(urlValue);
  const target = `${url.pathname}${url.search}`;
  const matches = policy.rules.flatMap((rule) => {
    const anchored = rule.value.endsWith("$");
    const pathRule = anchored ? rule.value.slice(0, -1) : rule.value;
    const escaped = pathRule
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*");
    const pattern = new RegExp(`^${escaped}${anchored ? "$" : ".*"}`);
    return pattern.test(target)
      ? [{ ...rule, specificity: rule.value.replace(/[*$]/g, "").length }]
      : [];
  }).sort((left, right) => right.specificity - left.specificity);

  if (!matches.length) return true;
  if (matches.length > 1 && matches[0].specificity === matches[1].specificity) {
    return matches[0].directive === "allow" || matches[1].directive === "allow";
  }
  return matches[0].directive === "allow";
}

async function getRobotsPolicy(page, origin) {
  try {
    const response = await page.request.get(`${origin}/robots.txt`, { timeout: 10_000 });
    if (response.status() === 404) {
      return { available: true, status: 404, rules: [] };
    }
    if (!response.ok()) {
      return {
        available: false,
        status: response.status(),
        error: `Could not read robots.txt (HTTP ${response.status()}); discovered pages will not be fetched.`,
      };
    }
    return {
      available: true,
      status: response.status(),
      rules: parseRobotsRules(await response.text()),
    };
  } catch (error) {
    return {
      available: false,
      status: null,
      error: `Could not read robots.txt; discovered pages will not be fetched: ${error.message}`,
    };
  }
}

function getRelevantLinks(links, sourceUrl) {
  const source = new URL(sourceUrl);
  const seen = new Set();

  return links.flatMap((link) => {
    try {
      const url = new URL(link.href, source);
      if (
        !["http:", "https:"].includes(url.protocol)
        || url.origin !== source.origin
        || ignoredFilePattern.test(url.href)
        || !relevantLinkPattern.test(`${link.text} ${url.pathname}`)
      ) {
        return [];
      }

      const canonicalUrl = canonicalizeUrl(url.href);
      if (seen.has(canonicalUrl)) return [];
      seen.add(canonicalUrl);
      return [{
        url: canonicalUrl,
        linkText: link.text.trim().slice(0, 200),
        priority: priorityLinkPattern.test(`${link.text} ${url.pathname}`) ? 1 : 0,
      }];
    } catch {
      return [];
    }
  }).sort((left, right) => right.priority - left.priority);
}

async function capturePage(page, url) {
  let response;
  try {
    response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
  } catch (error) {
    return {
      requestedUrl: url,
      capturedUrl: page.url(),
      fetchStatus: "navigation-error",
      fetchError: error.message,
      capturedAt: new Date().toISOString(),
      reviewStatus: "manual-review-required",
    };
  }

  if (!response) {
    return {
      requestedUrl: url,
      capturedUrl: page.url(),
      fetchStatus: "no-response",
      capturedAt: new Date().toISOString(),
      reviewStatus: "manual-review-required",
    };
  }

  const evidence = await page.evaluate((limit) => {
    const text = document.body?.innerText?.replace(/\s+/g, " ").trim() ?? "";
    return {
      title: document.title,
      description:
        document.querySelector('meta[name="description"]')?.content?.trim() ?? null,
      headings: [...document.querySelectorAll("h1, h2, h3")]
        .map((heading) => heading.textContent.trim())
        .filter(Boolean)
        .slice(0, 60),
      emails: [...document.querySelectorAll('a[href^="mailto:"]')]
        .map((link) => link.getAttribute("href").slice(7).split("?")[0])
        .filter(Boolean),
      links: [...document.querySelectorAll("a[href]")]
        .map((link) => ({
          href: link.href,
          text: link.innerText.trim() || link.getAttribute("aria-label") || "",
        }))
        .filter(({ href }) => href.startsWith("http")),
      text: text.slice(0, limit),
      textTruncated: text.length > limit,
    };
  }, textLimit);

  return {
    requestedUrl: url,
    capturedUrl: page.url(),
    httpStatus: response.status(),
    fetchStatus: response.ok() ? "ok" : "http-error",
    capturedAt: new Date().toISOString(),
    ...evidence,
    reviewStatus: response.ok() ? "needs-human-review" : "manual-review-required",
  };
}

async function captureCandidate(page, candidate) {
  const rootUrl = new URL(candidate.url);
  if (!["http:", "https:"].includes(rootUrl.protocol)) {
    throw new Error(`Unsupported URL protocol for ${candidate.name}: ${rootUrl.protocol}`);
  }

  const robotsPolicy = await getRobotsPolicy(page, rootUrl.origin);
  const canonicalRootUrl = canonicalizeUrl(rootUrl.href);
  if (!isAllowedByRobots(canonicalRootUrl, robotsPolicy)) {
    return {
      ...candidate,
      checkedAt: new Date().toISOString(),
      robotsStatus: robotsPolicy.status,
      robotsError: robotsPolicy.error,
      pageCount: 0,
      pages: [{
        requestedUrl: canonicalRootUrl,
        fetchStatus: "robots-disallowed",
        capturedAt: new Date().toISOString(),
        reviewStatus: "manual-review-required",
      }],
      reviewStatus: "manual-review-required",
    };
  }

  const queue = [{ url: canonicalRootUrl, depth: 0, linkText: "Candidate URL" }];
  const queuedUrls = new Set(queue.map(({ url }) => url));
  const pages = [];

  while (queue.length && pages.length < maxPagesPerFacility) {
    const current = queue.shift();
    const captured = await capturePage(page, current.url);
    const { links = [], ...pageEvidence } = captured;
    const relevantLinks = captured.fetchStatus === "ok"
      ? getRelevantLinks(links, captured.capturedUrl).map(({ priority, ...link }) => ({
        ...link,
        robotsAllowed: isAllowedByRobots(link.url, robotsPolicy),
        priority,
      }))
      : [];

    if (current.depth < maxLinkDepth) {
      for (const link of relevantLinks.filter(({ robotsAllowed }) => robotsAllowed)) {
        if (queuedUrls.has(link.url) || queue.length + pages.length >= maxPagesPerFacility) continue;
        queuedUrls.add(link.url);
        const { priority, robotsAllowed, ...queuedLink } = link;
        queue.push({
          ...queuedLink,
          depth: current.depth + 1,
          discoveredFrom: captured.capturedUrl,
        });
      }
    }
    pages.push({
      ...pageEvidence,
      relevantLinks: relevantLinks.map(({ priority, ...link }) => link),
      depth: current.depth,
      discoveredFrom: current.depth ? current.discoveredFrom : null,
      linkText: current.depth ? current.linkText : null,
    });
    await delay(requestDelayMs);
  }

  return {
    ...candidate,
    checkedAt: new Date().toISOString(),
    robotsStatus: robotsPolicy.status,
    robotsError: robotsPolicy.error ?? null,
    captureLimits: {
      maxPagesPerFacility,
      maxLinkDepth,
      requestDelayMs,
      sameOriginOnly: true,
    },
    pageCount: pages.length,
    pages,
    reviewStatus: pages.some(({ fetchStatus }) => fetchStatus !== "ok")
      ? "manual-review-required"
      : "needs-human-review",
  };
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  userAgent: `${crawlerUserAgent}/0.2 (human-reviewed research directory)`,
});
let allowedOrigin = null;
await page.route("**/*", async (route) => {
  const request = route.request();
  if (
    request.isNavigationRequest()
    && allowedOrigin
    && new URL(request.url()).origin !== allowedOrigin
  ) {
    await route.abort();
    return;
  }
  await route.continue();
});
const results = [];

try {
  for (const candidate of candidates) {
    allowedOrigin = new URL(candidate.url).origin;
    results.push(await captureCandidate(page, candidate));
  }
} finally {
  await browser.close();
}

await writeFile(outputPath, `${JSON.stringify(results, null, 2)}\n`, "utf8");
console.log(`Saved evidence for ${results.length} candidate(s) to ${outputPath.pathname}`);
