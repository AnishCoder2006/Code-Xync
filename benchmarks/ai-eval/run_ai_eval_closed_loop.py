"""
CodeSync Phase 5: Closed-Loop AI Fix Evaluation Runner.
Evaluates cases in benchmarks/ai-eval/cases through the LangGraph closed-loop agent
and hardened Docker sandbox runner.
Supports:
  --baseline : verify all cases fail on original buggy code with assertion failures (not syntax/import errors)
  --gold     : verify all cases pass (exit 0) with gold reference solutions through the real sandbox
  --results-json PATH : also write a machine-readable results file (Phase 6 B5), read by
                        benchmarks/report.py. Unknown values are null, never guessed.
"""

import os
import sys
import json
import time
import argparse
from typing import List, Dict, Any

# Ensure services/ai and benchmarks/ai-eval are on sys.path
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
AI_DIR = os.path.abspath(os.path.join(BASE_DIR, "..", "..", "services", "ai"))
if AI_DIR not in sys.path:
    sys.path.insert(0, AI_DIR)
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)

from app.agent.graph import run_agent, _call_sandbox
from app.agent.llm_provider import get_llm_provider, BaseLLMProvider
from gold_solutions import GOLD_SOLUTIONS


def extract_assertion_line(stderr: str, stdout: str) -> str:
    combined = (stderr or "") + "\n" + (stdout or "")
    lines = [l.strip() for l in combined.splitlines() if l.strip()]
    if not lines:
        return "No stderr/stdout"
    for l in lines:
        if "AssertionError" in l:
            return l
    for l in reversed(lines):
        if l.startswith("Node.js v") or l.startswith("at ") or l == "}":
            continue
        return l
    return lines[-1]


def run_baseline(cases_count: int = 25):
    cases_dir = os.path.join(BASE_DIR, "cases")
    case_dirs = sorted([d for d in os.listdir(cases_dir) if os.path.isdir(os.path.join(cases_dir, d))])
    selected_cases = case_dirs[:cases_count]

    print("=========================================================================================")
    print(f"       CodeSync Phase 5: AI Fix Benchmark BASELINE RUN ({len(selected_cases)} Cases)")
    print("       Testing original buggy source through real Docker sandbox path")
    print("=========================================================================================\n")

    results = []
    all_failed_as_required = True

    for idx, cdir in enumerate(selected_cases, start=1):
        case_path = os.path.join(cases_dir, cdir)
        info_file = os.path.join(case_path, "case_info.json")
        if not os.path.exists(info_file):
            continue

        with open(info_file, "r", encoding="utf-8") as f:
            info = json.load(f)

        target_file = info["target_file"]
        is_python = target_file.endswith(".py")
        language = "python" if is_python else "javascript"
        test_filename = "test_" + target_file if is_python else target_file.replace(".js", ".test.js")

        with open(os.path.join(case_path, target_file), "r", encoding="utf-8") as f:
            base_code = f.read()

        extra_files = {}
        test_file_path = os.path.join(case_path, test_filename)
        if os.path.exists(test_file_path):
            with open(test_file_path, "r", encoding="utf-8") as tf:
                extra_files[test_filename] = tf.read()

        test_cmd = ["python3", test_filename] if is_python else ["node", test_filename]

        t0 = time.perf_counter()
        try:
            res = _call_sandbox(
                working_content=base_code,
                language=language,
                file_path=target_file,
                test_command=test_cmd,
                room_id=f"baseline-{info['id']}",
                extra_files=extra_files,
            )
            exit_code = res.get("exitCode")
            status = res.get("status", "unknown")
            last_err = extract_assertion_line(res.get("stderr") or "", res.get("stdout") or "")
        except Exception as e:
            exit_code = -1
            status = f"error"
            last_err = str(e)

        elapsed_s = time.perf_counter() - t0

        # Confirm assertion failure, NOT import or syntax error
        has_syntax_or_import = any(k in last_err for k in ["SyntaxError", "ImportError", "ModuleNotFoundError", "TypeError", "ReferenceError"])
        is_assertion_failure = (exit_code is not None and exit_code != 0) and not has_syntax_or_import

        if not is_assertion_failure:
            all_failed_as_required = False

        results.append({
            "idx": idx,
            "id": info["id"],
            "target_file": target_file,
            "language": language,
            "exit_code": exit_code,
            "last_err": last_err,
            "is_assertion_failure": is_assertion_failure,
            "time_s": round(elapsed_s, 2),
        })

    # Print markdown table
    print("\n| # | Case ID | Lang | Exit | Last Stderr Line | Assertion Failure? | Time |")
    print("|---|---------|------|------|------------------|--------------------|------|")
    for r in results:
        res_str = "YES (Assert)" if r["is_assertion_failure"] else "**NO (Syntax/Import/Pass)**"
        clean_err = r["last_err"][:38] + ("..." if len(r["last_err"]) > 38 else "")
        print(f"| {r['idx']:02d} | {r['id']:<24} | {r['language']:<6} | {str(r['exit_code']):<4} | {clean_err:<41} | {res_str:<18} | {r['time_s']:.2f}s |")

    total = len(results)
    passed_count = sum(1 for r in results if r["is_assertion_failure"])
    print(f"\n=========================================================================================")
    print(f"Baseline Summary: {passed_count}/{total} cases fail on verified assertion (zero import/syntax errors).")
    print("=========================================================================================\n")

    if not all_failed_as_required:
        print("ERROR: One or more cases did not fail with an assertion failure! Fix or remove them.")
        sys.exit(1)

    return results


def run_gold(cases_count: int = 25):
    cases_dir = os.path.join(BASE_DIR, "cases")
    case_dirs = sorted([d for d in os.listdir(cases_dir) if os.path.isdir(os.path.join(cases_dir, d))])
    selected_cases = case_dirs[:cases_count]

    print("=========================================================================================")
    print(f"       CodeSync Phase 5: AI Fix Benchmark GOLD SOLUTIONS RUN ({len(selected_cases)} Cases)")
    print("       Testing gold reference solutions through real Docker sandbox path")
    print("=========================================================================================\n")

    results = []
    all_passed = True

    for idx, cdir in enumerate(selected_cases, start=1):
        case_path = os.path.join(cases_dir, cdir)
        info_file = os.path.join(case_path, "case_info.json")
        if not os.path.exists(info_file):
            continue

        with open(info_file, "r", encoding="utf-8") as f:
            info = json.load(f)

        cid = info["id"]
        gold_code = GOLD_SOLUTIONS.get(cid)
        if not gold_code:
            print(f"Error: missing gold solution for {cid}")
            sys.exit(1)

        target_file = info["target_file"]
        is_python = target_file.endswith(".py")
        language = "python" if is_python else "javascript"
        test_filename = "test_" + target_file if is_python else target_file.replace(".js", ".test.js")

        extra_files = {}
        test_file_path = os.path.join(case_path, test_filename)
        if os.path.exists(test_file_path):
            with open(test_file_path, "r", encoding="utf-8") as tf:
                extra_files[test_filename] = tf.read()

        test_cmd = ["python3", test_filename] if is_python else ["node", test_filename]

        t0 = time.perf_counter()
        try:
            res = _call_sandbox(
                working_content=gold_code,
                language=language,
                file_path=target_file,
                test_command=test_cmd,
                room_id=f"gold-{info['id']}",
                extra_files=extra_files,
            )
            exit_code = res.get("exitCode")
            status = res.get("status", "unknown")
            output = (res.get("stdout") or "") + (res.get("stderr") or "")
        except Exception as e:
            exit_code = -1
            status = "error"
            output = str(e)

        elapsed_s = time.perf_counter() - t0
        passed = (exit_code == 0)
        if not passed:
            all_passed = False

        results.append({
            "idx": idx,
            "id": cid,
            "target_file": target_file,
            "language": language,
            "exit_code": exit_code,
            "status": status,
            "passed": passed,
            "output": output.strip().splitlines()[-1] if output.strip() else "",
            "time_s": round(elapsed_s, 2),
        })

    print("\n| # | Case ID | Target File | Lang | Exit Code | Verified Gold (Exit 0)? | Time |")
    print("|---|---------|-------------|------|-----------|--------------------------|------|")
    for r in results:
        res_str = "PASS (Exit 0)" if r["passed"] else "**FAIL**"
        print(f"| {r['idx']:02d} | {r['id']:<24} | {r['target_file']:<16} | {r['language']:<10} | {str(r['exit_code']):<9} | {res_str:<24} | {r['time_s']:.2f}s |")

    total = len(results)
    passed_count = sum(1 for r in results if r["passed"])
    print(f"\n=========================================================================================")
    print(f"Gold Summary: {passed_count}/{total} gold solutions pass (Exit 0) through real sandbox.")
    print("=========================================================================================\n")

    if not all_passed:
        print("ERROR: One or more gold solutions failed to exit 0!")
        sys.exit(1)

    return results


def _environment() -> Dict[str, Any]:
    import platform
    import subprocess

    def sh(cmd):
        try:
            return subprocess.run(cmd, capture_output=True, text=True, timeout=20).stdout.strip() or None
        except Exception:
            return None

    head = sh(["git", "rev-parse", "--verify", "-q", "HEAD"])
    return {
        "git": {
            "commit": head,
            "commit_note": None if head else "branch has no commits; results come from the uncommitted working tree",
            "last_pushed_commit": sh(["git", "rev-parse", "--verify", "-q", "origin/main"]),
        },
        "environment": {
            "os": f"{platform.system()} {platform.release()} ({platform.machine()})",
            "cpu": platform.processor() or None,
            "logical_cpus": os.cpu_count(),
            "python": platform.python_version(),
            "docker": sh(["docker", "version", "--format", "client {{.Client.Version}} / server {{.Server.Version}}"]),
        },
    }


def write_results_json(path: str, provider_name: str, model_name: str, results: List[Dict[str, Any]], summary: Dict[str, Any]):
    """Phase 6 B5 results file. Every per-case number comes from the run; unknown -> null."""
    env = _environment()
    models_seen = sorted({m for r in results for m in (r.get("models_reported") or []) if m})
    doc = {
        "schema": "codesync-ai-eval/v1",
        "name": "b5-ai-eval",
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        **env,
        "provider": provider_name,
        "model_requested": model_name,
        "models_reported_by_provider": models_seen or None,
        "cases": results,
        "summary": summary,
        "notes": [
            "time_s is end-to-end fix time per case: LLM provider latency + edit apply + sandbox test runs (+ retries).",
            "attempts = LLM calls made for the case (1 + regenerations after failed sandbox tests).",
            "Token counts are null when the provider did not report them; cost_usd is the provider-reported/estimated cost.",
        ],
    }
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=1)
    print(f"Wrote results JSON: {path}")


def run_eval(cases_count: int = 25, provider_name: str = "ollama", model_name: str = "qwen2.5-coder:0.5b", results_json: str = None):
    os.environ["LLM_PROVIDER"] = provider_name
    if provider_name == "ollama":
        os.environ["OLLAMA_MODEL"] = model_name
    elif provider_name == "openai":
        os.environ["OPENAI_MODEL"] = model_name
    elif provider_name == "gemini":
        os.environ["GEMINI_MODEL"] = model_name
    elif provider_name == "anthropic":
        os.environ["ANTHROPIC_MODEL"] = model_name

    cases_dir = os.path.join(BASE_DIR, "cases")
    case_dirs = sorted([d for d in os.listdir(cases_dir) if os.path.isdir(os.path.join(cases_dir, d))])
    selected_cases = case_dirs[:cases_count]

    provider = get_llm_provider()

    print("=========================================================================================")
    print(f"       CodeSync Phase 5: Closed-Loop AI Fix Benchmark ({len(selected_cases)} Cases)")
    print(f"       Provider: {provider_name.upper()} | Model: {model_name}")
    print("=========================================================================================\n")

    results = []
    first_attempt_passes = 0
    after_retry_passes = 0
    total_cost = 0.0
    total_tokens = 0
    has_provider_tokens = False

    for idx, cdir in enumerate(selected_cases, start=1):
        case_path = os.path.join(cases_dir, cdir)
        info_file = os.path.join(case_path, "case_info.json")
        if not os.path.exists(info_file):
            continue

        with open(info_file, "r", encoding="utf-8") as f:
            info = json.load(f)

        target_file = info["target_file"]
        is_python = target_file.endswith(".py")
        language = "python" if is_python else "javascript"
        test_filename = "test_" + target_file if is_python else target_file.replace(".js", ".test.js")

        with open(os.path.join(case_path, target_file), "r", encoding="utf-8") as f:
            base_code = f.read()

        # Mount test file next to target file in snapshot
        extra_files = {}
        test_file_path = os.path.join(case_path, test_filename)
        if os.path.exists(test_file_path):
            with open(test_file_path, "r", encoding="utf-8") as tf:
                extra_files[test_filename] = tf.read()

        # Build test command
        test_cmd = ["python3", test_filename] if is_python else ["node", test_filename]

        t0 = time.perf_counter()
        res = run_agent(
            room_id=f"eval-{info['id']}",
            prompt=info.get("description", info["query"]),
            base_text=base_code,
            base_version="eval-base-v1",
            language=language,
            file_path=target_file,
            test_command=test_cmd,
            extra_files=extra_files,
            llm_provider=provider,
        )
        elapsed_s = time.perf_counter() - t0

        status = res.get("status", "error")
        retries = res.get("retry_count", 0)
        calls = res.get("llm_calls", 1)
        cost = res.get("total_cost_usd", 0.0)
        llm_responses = res.get("llm_responses", [])

        # Eval honesty: cost is $0 for local models and token counts come ONLY from provider
        case_tokens = None
        prompt_tokens = None
        comp_tokens = None
        for r in llm_responses:
            if r.get("total_tokens") is not None:
                has_provider_tokens = True
                case_tokens = (case_tokens or 0) + r["total_tokens"]
                total_tokens += r["total_tokens"]
            if r.get("prompt_tokens") is not None:
                prompt_tokens = (prompt_tokens or 0) + r["prompt_tokens"]
            if r.get("completion_tokens") is not None:
                comp_tokens = (comp_tokens or 0) + r["completion_tokens"]

        total_cost += cost

        if status == "verified":
            if retries == 0 and calls == 1:
                first_attempt_passes += 1
            else:
                after_retry_passes += 1

        token_str = f"{case_tokens:>5} (p:{prompt_tokens}/c:{comp_tokens})" if case_tokens is not None else " null"

        latencies = [r.get("latency_ms") for r in llm_responses if r.get("latency_ms") is not None]
        results.append({
            "idx": idx,
            "id": info["id"],
            "title": info["title"],
            "status": status,
            "calls": calls,
            "attempts": calls,
            "retries": retries,
            "prompt_tokens": prompt_tokens,
            "completion_tokens": comp_tokens,
            "tokens": case_tokens,
            "cost_usd": cost,
            "time_s": round(elapsed_s, 2),
            "provider_latency_ms_total": round(sum(latencies), 1) if latencies else None,
            "models_reported": sorted({r.get("model") for r in llm_responses if r.get("model")}) or None,
        })

        print(f"[{idx:02d}/{len(selected_cases)}] {info['id']:<28} | Status: {status:<10} | Calls: {calls} | Tokens: {token_str} | Cost: ${cost:.6f} | Time: {elapsed_s:.2f}s")

    total_evaluated = len(results)
    first_pass_rate = (first_attempt_passes / total_evaluated * 100.0) if total_evaluated else 0.0
    cumulative_passes = first_attempt_passes + after_retry_passes
    after_retry_rate = (cumulative_passes / total_evaluated * 100.0) if total_evaluated else 0.0

    print("\n=========================================================================================")
    print("                              EVALUATION BENCHMARK SUMMARY                               ")
    print("=========================================================================================")
    print(f"Provider:                {provider_name}")
    print(f"Model:                   {model_name}")
    print(f"Total Cases Evaluated:   {total_evaluated}")
    print(f"First-Attempt Passes:    {first_attempt_passes} ({first_pass_rate:.1f}%)")
    print(f"Passes After Retry:      {after_retry_passes}")
    print(f"Total Verified:          {cumulative_passes} ({after_retry_rate:.1f}%)")
    print(f"Total Tokens:            {total_tokens if has_provider_tokens else 'null'}")
    print(f"Total Estimated Cost:    ${total_cost:.6f}")
    print("=========================================================================================\n")

    if results_json:
        write_results_json(results_json, provider_name, model_name, results, {
            "cases_evaluated": total_evaluated,
            "verified_first_attempt": first_attempt_passes,
            "verified_after_retry": after_retry_passes,
            "verified_total": cumulative_passes,
            "total_tokens": total_tokens if has_provider_tokens else None,
            "total_cost_usd": round(total_cost, 6),
        })

    return results


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--count", type=int, default=25, help="Number of cases to evaluate (default 25)")
    parser.add_argument("--provider", type=str, default="ollama", help="LLM Provider (default: ollama)")
    parser.add_argument("--model", type=str, default="qwen2.5-coder:0.5b", help="Model name")
    parser.add_argument("--baseline", action="store_true", help="Run baseline test of original source through sandbox")
    parser.add_argument("--gold", action="store_true", help="Run gold reference solutions through sandbox")
    parser.add_argument("--results-json", type=str, default=None, help="Write machine-readable results to this path (e.g. benchmarks/results/b5-ai-eval.json)")
    args = parser.parse_args()

    if args.baseline:
        run_baseline(cases_count=args.count)
    elif args.gold:
        run_gold(cases_count=args.count)
    else:
        run_eval(cases_count=args.count, provider_name=args.provider, model_name=args.model, results_json=args.results_json)
