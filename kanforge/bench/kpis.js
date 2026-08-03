// Benchmark KPI definitions (architecture.md §1).
export function calculateBenchmarkKPIs(results) {
    const total = results.length;
    const passed = results.filter(r => r.ok).length;
    return {
        totalTargets: total,
        passedTargets: passed,
        passRate: total > 0 ? passed / total : 0
    };
}
