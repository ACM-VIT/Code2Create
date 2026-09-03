import { ConvexError } from "convex/values";

export type GitHubRepositoryLocation = {
  owner: string;
  name: string;
  url: string;
};

export function parseGitHubRepositoryLocation(value: string): GitHubRepositoryLocation {
  if (value.length > 2_048) {
    throw new ConvexError({
      code: "GITHUB_URL_INVALID",
      message: "Enter a GitHub repository link.",
    });
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new ConvexError({
      code: "GITHUB_URL_INVALID",
      message: "Enter a GitHub repository link.",
    });
  }
  if (
    url.protocol !== "https:" ||
    !["github.com", "www.github.com"].includes(url.hostname) ||
    url.port ||
    url.username ||
    url.password
  ) {
    throw new ConvexError({
      code: "GITHUB_URL_INVALID",
      message: "Enter a link from github.com.",
    });
  }
  const segments = url.pathname.split("/").filter(Boolean);
  const owner = segments[0];
  const encodedName = segments[1];
  if (!owner || !encodedName) {
    throw new ConvexError({
      code: "GITHUB_URL_INVALID",
      message: "Enter a GitHub repository link.",
    });
  }
  let name: string;
  try {
    name = decodeURIComponent(encodedName).replace(/\.git$/u, "");
  } catch {
    throw new ConvexError({
      code: "GITHUB_URL_INVALID",
      message: "The GitHub repository name is invalid.",
    });
  }
  if (
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner) ||
    !/^[A-Za-z0-9._-]{1,100}$/.test(name) ||
    name === "." ||
    name === ".."
  ) {
    throw new ConvexError({
      code: "GITHUB_URL_INVALID",
      message: "The GitHub repository link is invalid.",
    });
  }
  return {
    owner,
    name,
    url: `https://github.com/${owner}/${name}`,
  };
}
