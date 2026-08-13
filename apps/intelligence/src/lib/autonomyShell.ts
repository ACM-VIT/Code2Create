export type AutonomyShellToolCall = {
	tool: string;
	isError: boolean;
};

export type AutonomyShellSettlement =
	| 'completed'
	| 'recoverable_missing_tool'
	| 'recoverable_tool_failure';

export function classifyAutonomyShellSettlement(
	toolCalls: readonly AutonomyShellToolCall[],
): AutonomyShellSettlement {
	const workItemCalls = toolCalls.filter(
		(call) => call.tool === 'run_autonomy_work_item',
	);
	if (workItemCalls.length === 0) return 'recoverable_missing_tool';
	return workItemCalls.some((call) => !call.isError)
		? 'completed'
		: 'recoverable_tool_failure';
}
