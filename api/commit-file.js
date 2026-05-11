// /api/commit-file.js
// Commits a file to the lhs-knowledge-base repo using a GitHub Personal Access Token.
// Used by Claude (Number One) to update knowledge files and scheduler assets directly.

export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  // Simple shared-secret auth so only Claude (and the user) can call this.
  const authHeader = req.headers['x-claude-secret'];
  if (!process.env.CLAUDE_COMMIT_SECRET) {
    return res.status(500).json({ error: 'Server missing CLAUDE_COMMIT_SECRET configuration.' });
  }
  if (authHeader !== process.env.CLAUDE_COMMIT_SECRET) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }

  // Verify GitHub PAT exists
  const pat = process.env.GITHUB_PAT;
  if (!pat) {
    return res.status(500).json({ error: 'Server missing GITHUB_PAT configuration.' });
  }

  // Parse the request body
  const { path, content, message, branch = 'main' } = req.body || {};

  if (!path || typeof content !== 'string' || !message) {
    return res.status(400).json({
      error: 'Missing required fields. Need: path (string), content (string), message (string). Optional: branch (default "main").'
    });
  }

  const repo = 'Mckaren67/lhs-knowledge-base';
  const apiUrl = `https://api.github.com/repos/${repo}/contents/${path}`;

  try {
    // Step 1: Check if the file already exists (to get its SHA for an update)
    let existingSha = null;
    const checkResponse = await fetch(`${apiUrl}?ref=${branch}`, {
      headers: {
        'Authorization': `Bearer ${pat}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'lhs-knowledge-base-commit-endpoint'
      }
    });

    if (checkResponse.ok) {
      const existing = await checkResponse.json();
      existingSha = existing.sha;
    } else if (checkResponse.status !== 404) {
      const errBody = await checkResponse.text();
      return res.status(checkResponse.status).json({
        error: 'GitHub check failed',
        details: errBody
      });
    }

    // Step 2: Commit the file (create or update)
    const commitBody = {
      message,
      content: Buffer.from(content, 'utf-8').toString('base64'),
      branch
    };
    if (existingSha) {
      commitBody.sha = existingSha;
    }

    const commitResponse = await fetch(apiUrl, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${pat}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'User-Agent': 'lhs-knowledge-base-commit-endpoint'
      },
      body: JSON.stringify(commitBody)
    });

    if (!commitResponse.ok) {
      const errBody = await commitResponse.text();
      return res.status(commitResponse.status).json({
        error: 'GitHub commit failed',
        details: errBody
      });
    }

    const result = await commitResponse.json();
    return res.status(200).json({
      success: true,
      action: existingSha ? 'updated' : 'created',
      path,
      commit_sha: result.commit?.sha,
      commit_url: result.commit?.html_url
    });

  } catch (error) {
    return res.status(500).json({
      error: 'Unexpected error',
      message: error.message
    });
  }
}
