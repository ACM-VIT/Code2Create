import type { FlueHarness, ToolStep } from '@flue/runtime';

import type { AutonomyArtifactStore } from './autonomyArtifacts.ts';
import type { AutonomyRunState } from './autonomyContext.ts';
import type { AutonomyLifecycleWriter } from './autonomyLifecycle.ts';
import type { OperationsAutonomyInput } from './autonomyProtocol.ts';
import type { AutonomyProgress } from './autonomyTraversal.ts';
import type { AutonomyBindings } from './autonomyTransport.ts';

export type AutonomyOrchestrationResult = {
	progress: AutonomyProgress;
	outcome: 'continuing' | 'terminal';
};

export type RunAutonomyWorkItemArgs = {
	input: OperationsAutonomyInput;
	state: AutonomyRunState;
	progress: AutonomyProgress;
	workItemId: string;
	harness: FlueHarness;
	step: ToolStep;
	writeLifecycle: AutonomyLifecycleWriter;
	agentVersion: string;
	model: string;
	bindings: AutonomyBindings;
	artifacts: AutonomyArtifactStore;
	signal?: AbortSignal;
};
