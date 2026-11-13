/** Shared GitHub API helper. */
export function makeGhApi(token: string, agentName: string) {
  return async (path: string, method = "GET", body?: unknown): Promise<any> => {
    const response = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": agentName,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    // An error page from GitHub's edge is not JSON; report it like any other failure.
    const data = await response.json().catch(() => ({ message: `GitHub returned HTTP ${response.status}` }));
    if (data && typeof data === "object") {
      Object.defineProperty(data, "_httpStatus", { value: response.status, enumerable: false });
      return data;
    }
    return { data, _httpStatus: response.status };
  };
}
