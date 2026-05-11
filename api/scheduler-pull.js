// /api/scheduler-pull.js
// Pulls HCP jobs via the existing proxy, filters to scheduled, translates trainee
// placeholder tags to real worker names, and returns a lean JSON payload for the
// scheduler frontend.
//
// Query params:
//   start (ISO date, e.g. 2026-05-11) — required
//   end   (ISO date, e.g. 2026-05-17) — required
//
// Notes:
//   - HCP returns ALL jobs (incl. canceled/deleted) — we filter by work_status === 'scheduled'.
//   - Karen M placeholder convention: jobs assigned to "Karen M" with a tag like
//     "Heidi DeGrow" mean the real worker is Heidi. We translate transparently.

const PROXY_BASE = 'https://lhs-scheduler-proxy.vercel.app/api/proxy';

const TRAINEE_TAG_MAP = {
  'heidi degrow': 'Heidi',
  'rhythm sidhu': 'Rytham',
  'ladda bouttavong': 'Lada',
};

function shortName(first, last) {
  if (first && last) return `${first} ${last.charAt(0)}`;
  return first || '';
}

function translateCrew(hcpCrew, tagString) {
  const crew = [...hcpCrew];
  if (!tagString) return { realCrew: crew, isTraineePair: false };

  const tagLower = tagString.toLowerCase();
  let realName = null;
  for (const [placeholder, name] of Object.entries(TRAINEE_TAG_MAP)) {
    if (tagLower.includes(placeholder)) {
      realName = name;
      break;
    }
  }
  if (!realName) return { realCrew: crew, isTraineePair: false };

  // Replace Karen M with the tagged real worker
  const realCrew = crew.map((c) => (c === 'Karen M' ? realName : c));
  return { realCrew, isTraineePair: true };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed. Use GET.' });
  }

  const { start, end } = req.query;
  if (!start || !end) {
    return res.status(400).json({
      error: 'Missing required query params: start, end (both ISO dates, e.g. 2026-05-11)',
    });
  }

  // Build the HCP endpoint string and URL-encode it for the proxy
  const startIso = `${start}T00:00:00Z`;
  const endIso = `${end}T23:59:59Z`;
  const hcpEndpoint = `jobs?page_size=200&scheduled_start_min=${startIso}&scheduled_start_max=${endIso}`;
  const proxyUrl = `${PROXY_BASE}?endpoint=${encodeURIComponent(hcpEndpoint)}`;

  try {
    const upstream = await fetch(proxyUrl);
    if (!upstream.ok) {
      const body = await upstream.text();
      return res.status(upstream.status).json({
        error: 'Upstream HCP proxy returned an error',
        status: upstream.status,
        body: body.slice(0, 500),
      });
    }

    const data = await upstream.json();
    const allJobs = data.jobs || [];

    // Filter to active scheduled jobs and shape them
    const jobs = [];
    for (const j of allJobs) {
      if (j.work_status !== 'scheduled') continue;

      const c = j.customer || {};
      const customer = c.last_name
        ? `${c.first_name || ''} ${c.last_name}`.trim()
        : c.first_name || '';

      const a = j.address || {};
      const addressParts = [a.street, a.street_line_2, a.city, a.state, a.zip].filter(Boolean);
      const address = addressParts.join(', ');

      const hcpCrew = (j.assigned_employees || []).map((e) =>
        shortName(e.first_name, e.last_name)
      ).filter(Boolean);

      const tags = (j.tags || []).join(', ');
      const { realCrew, isTraineePair } = translateCrew(hcpCrew, tags);

      const sched = j.schedule || {};
      jobs.push({
        id: j.id,
        customer,
        address,
        notes: j.notes || '',
        invoiceNumber: j.invoice_number,
        start: sched.scheduled_start,
        end: sched.scheduled_end,
        hcpCrew,
        crew: realCrew,
        tags,
        isTraineePair,
      });
    }

    // Sort by start time
    jobs.sort((a, b) => (a.start || '').localeCompare(b.start || ''));

    return res.status(200).json({
      pulled_at: new Date().toISOString(),
      range: { start, end },
      total_returned_by_hcp: allJobs.length,
      active_count: jobs.length,
      jobs,
    });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to pull HCP', message: error.message });
  }
}
