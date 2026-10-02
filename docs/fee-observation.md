# Read-only fee observation

Run `node scripts/fee-observation.mjs` with existing read-only `gh` access. The
expected valuation date defaults to the benchmark cache's latest complete common
SPY/QQQ session, so holidays are not guessed. To inspect a known target, use
`--target-date=YYYY-MM-DD`. `--input=/absolute/file.json` supports offline evidence;
that JSON supplies public/main ciphertext as base64 plus workflow/run/health
metadata. No financial credential is needed or read.

The tool issues only fixed GitHub and public Pages GETs. It does not dispatch a
workflow, create an issue, send a message, commit, publish or decrypt data. It
pins main, paginates enough producer history to cover today, and fails observation
if main changes during collection. Trigger, producer, main/public health, target
lag and ciphertext drift produce separate amount-free diagnostic codes.

On HKT Tuesday–Saturday, absence of a scheduled fee-producer run is reported only
after the first existing 11:30 slot plus a 30-minute observation grace period.
Queued/running jobs count as observed. Manual successes and manual candidate
publication do not hide a missing scheduled run. “No scheduled run observed” is
an observation, not a diagnosis that GitHub dropped an event. No schedule is
changed by this tool.

Exit 0 means the public-only checks found no attention item; exit 2 reports known
stage attention items; exit 1 means evidence collection could not be completed.
The output never claims private fee-receipt or investor-page acceptance. A fee
publication is fully accepted only after those existing private and UI checks
also pass. No alert delivery or independent timer has been activated. This tool
is an executable input for a later approved watcher, not a promise of continuous
monitoring.
