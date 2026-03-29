// GitHub API response types

export interface GitHubCommit {
  sha: string;
  commit: {
    message: string;
    author: {
      name: string;
      email: string;
      date: string;
    };
  };
  author: {
    login: string;
    avatar_url: string;
  } | null;
  files?: GitHubCommitFile[];
}

export interface GitHubCommitFile {
  filename: string;
  status: "added" | "removed" | "modified" | "renamed";
  additions: number;
  deletions: number;
}

export interface GitHubPullRequest {
  number: number;
  title: string;
  state: "open" | "closed";
  user: {
    login: string;
    avatar_url: string;
  };
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  html_url: string;
}

export interface GitHubDiscussion {
  id: string;
  number: number;
  title: string;
  body: string;
  author: {
    login: string;
  };
  createdAt: string;
  comments: {
    nodes: GitHubDiscussionComment[];
  };
}

export interface GitHubDiscussionComment {
  id: string;
  body: string;
  author: {
    login: string;
  };
  createdAt: string;
}

export interface GitHubRateLimit {
  remaining: number;
  reset: number; // Unix timestamp
}
