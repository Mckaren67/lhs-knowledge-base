import fs from 'node:fs';
import path from 'node:path';

export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const candidatesDir = path.join(process.cwd(), 'docs', 'projects', 'candidates');
  const indexPath = path.join(candidatesDir, 'CANDIDATE_INDEX.md');

  try {
    const md = fs.readFileSync(indexPath, 'utf8');
    let onDiskFiles = [];
    try { onDiskFiles = fs.readdirSync(candidatesDir); } catch (_) {}
    return res.status(200).json({
      index_markdown: md,
      files_on_disk: onDiskFiles.filter(f => f.endsWith('.md') && f !== 'CANDIDATE_INDEX.md'),
      source: 'docs/projects/candidates/CANDIDATE_INDEX.md'
    });
  } catch (err) {
    return res.status(500).json({ error: 'Could not read candidate index', details: err.message });
  }
}
