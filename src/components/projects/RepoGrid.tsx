import { useState, useEffect } from "preact/hooks";

interface Repo {
  id: number;
  name: string;
  description: string | null;
  html_url: string;
  language: string | null;
  stargazers_count: number;
  forks_count: number;
  topics: string[];
  updated_at: string;
  fork: boolean;
}

const LANG_COLORS: Record<string, string> = {
  JavaScript: "#f7df1e",
  TypeScript: "#3178c6",
  Python: "#3572A5",
  Java: "#b07219",
  "C++": "#f34b7d",
  CSS: "#563d7c",
  HTML: "#e34c26",
  Shell: "#89e051",
  Go: "#00ADD8",
};

function RepoCard({ repo }: { repo: Repo }) {
  const langColor = repo.language ? (LANG_COLORS[repo.language] ?? "#8b949e") : null;
  const updated = new Date(repo.updated_at).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
  });

  return (
    <a href={repo.html_url} target="_blank" rel="noopener noreferrer" class="repo-card">
      <div class="repo-header">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="repo-icon">
          <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" />
        </svg>
        <span class="repo-name">{repo.name}</span>
      </div>

      {repo.description && (
        <p class="repo-desc">{repo.description}</p>
      )}

      {repo.topics.length > 0 && (
        <div class="repo-topics">
          {repo.topics.slice(0, 4).map((t) => (
            <span key={t} class="repo-topic">{t}</span>
          ))}
        </div>
      )}

      <div class="repo-footer">
        {langColor && (
          <span class="repo-lang">
            <span class="lang-dot" style={{ background: langColor }}></span>
            {repo.language}
          </span>
        )}
        {repo.stargazers_count > 0 && (
          <span class="repo-stat">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
            {repo.stargazers_count}
          </span>
        )}
        {repo.forks_count > 0 && (
          <span class="repo-stat">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/></svg>
            {repo.forks_count}
          </span>
        )}
        <span class="repo-updated">{updated}</span>
      </div>
    </a>
  );
}

export default function RepoGrid({ username }: { username: string }) {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`https://api.github.com/users/${username}/repos?sort=updated&per_page=30`)
      .then((r) => {
        if (!r.ok) throw new Error(`GitHub API error: ${r.status}`);
        return r.json();
      })
      .then((data: Repo[]) => {
        setRepos(data.filter((r) => !r.fork).slice(0, 12));
        setLoading(false);
      })
      .catch((e) => {
        setError(e.message);
        setLoading(false);
      });
  }, [username]);

  if (loading) {
    return (
      <div class="repo-loading">
        <div class="loading-grid">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} class="repo-skeleton" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div class="repo-error">
        <p>Could not load repositories. <a href={`https://github.com/${username}`} target="_blank" rel="noopener">View on GitHub →</a></p>
      </div>
    );
  }

  if (repos.length === 0) {
    return (
      <div class="repo-empty">
        <p>No public repositories found.</p>
      </div>
    );
  }

  return (
    <div class="repo-grid">
      {repos.map((repo) => (
        <RepoCard key={repo.id} repo={repo} />
      ))}
    </div>
  );
}
