#!/usr/bin/env python3
"""Opt-in REAL model acceptance. Costs model tokens; never part of npm test.
Usage: python scripts/acceptance.py --live [--team]
Stores fixtures/results under cwd/.local/magic-review-acceptance/<uuid>.
"""
import argparse, concurrent.futures, json, os, pathlib, signal, subprocess, uuid
parser = argparse.ArgumentParser()
parser.add_argument('--live', action='store_true', required=True)
parser.add_argument('--team', action='store_true')
parser.add_argument('--scenario', choices=['all', 'code', 'paper', 'team'], default='all')
args = parser.parse_args()
repo = pathlib.Path(__file__).resolve().parents[3]
package = pathlib.Path(__file__).resolve().parents[1]
root = pathlib.Path.cwd() / '.local' / 'magic-review-acceptance' / str(uuid.uuid4())
root.mkdir(parents=True)

def fixture(name):
    cwd = root / name; cwd.mkdir()
    if name != 'paper':
        def git(*argv): subprocess.run(['git', *argv], cwd=cwd, check=True, capture_output=True)
        git('init', '-b', 'main'); git('config', 'user.name', 'Magic Review Fixture'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'commit.gpgsign', 'false')
        file = cwd / 'sum.py'; file.write_text('def add(a, b):\n    """Return the sum of a and b."""\n    return a + b\n')
        git('add', '.'); git('commit', '-m', 'Correct addition')
        file.write_text('def add(a, b):\n    """Return the sum of a and b."""\n    return a - b\n')
        git('add', '.'); git('commit', '-m', 'Refactor addition')
    else:
        (cwd / 'main.tex').write_text(r'''\documentclass{article}
\begin{document}
\section{Claim}
Our algorithm is faster than every existing method on every dataset.
\section{Evidence}
We measured one run on one toy dataset. Our method took 10 seconds;
we did not evaluate other methods. This proves the universal claim.
\section{Derivation}
For all real numbers a and b, (a+b)^2=a^2+b^2.
\end{document}
''')
    return cwd

def run(name):
    cwd = fixture(name)
    backend = 'team' if name == 'team' else 'model'
    kind = 'paper' if name == 'paper' else 'code'
    target = 'main.tex' if kind == 'paper' else 'HEAD'
    request = {'kind': kind, 'target': target, 'budget': {'maxCalls': 6, 'maxTokens': 100000, 'timeoutMs': 240000}}
    prompt = ('Execute this plugin acceptance scenario. Do not edit or execute fixture source, do not load skills. '
              'Call magic_review_prepare with ' + json.dumps(request) + '. Then call magic_review_run with its returned ID and backend=' + backend + '. '
              'Team backend is explicitly authorized for this acceptance test. After completion, only summarize actual state and report paths. '
              'If any call fails, report it and stop; do not retry or fabricate findings.')
    command = ['pi', '--offline', '--no-mcp', '--no-context-files', '--no-skills', '--no-extensions', '--no-session', '--approve',
               '-e', str(package / 'extensions/index.ts'), '--mode', 'json', '--print']
    tools = ['magic_review_prepare', 'magic_review_run']
    if backend == 'team':
        command += ['-e', str(repo / '.pi/extensions/agent-team/index.ts')]
        tools += ['team', 'subagent']
    command += ['--tools', ','.join(tools), prompt]
    process = subprocess.Popen(command, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
    timed_out = False
    try: stdout, stderr = process.communicate(timeout=300)
    except subprocess.TimeoutExpired:
        timed_out = True
        os.killpg(process.pid, signal.SIGTERM)
        try: stdout, stderr = process.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL); stdout, stderr = process.communicate()
    (cwd / 'events.jsonl').write_text(stdout); (cwd / 'stderr.log').write_text(stderr)
    runs = []
    for file in (cwd / '.local/magic-review').glob('*/run.json'):
        state = json.loads(file.read_text())
        runs.append({k: state.get(k) for k in ['id', 'state', 'calls', 'usage', 'reportPaths', 'error']})
        runs[-1]['confirmed'] = sum(f.get('verificationDecision') == 'confirmed' for f in state.get('findings', []))
    result = {'scenario': name, 'cwd': str(cwd), 'exit': process.returncode, 'timeout': timed_out, 'runs': runs,
              'passed': not timed_out and process.returncode == 0 and len(runs) == 1 and runs[0]['state'] == 'completed' and (runs[0]['confirmed'] >= 2 if name == 'paper' else runs[0]['confirmed'] == 1)}
    return result

names = (['code', 'paper'] + (['team'] if args.team else [])) if args.scenario == 'all' else [args.scenario]
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
    results = list(pool.map(run, names))
(root / 'results.json').write_text(json.dumps(results, indent=2))
print(json.dumps({'resultsPath': str(root / 'results.json'), 'results': results}, indent=2))
raise SystemExit(0 if all(r['passed'] for r in results) else 1)
