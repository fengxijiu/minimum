export {
	findDanglingDeps,
	findGlobConflicts,
	validateContract,
	type ValidationResult,
} from "./ContractValidator.js";
export {
	classifyTaskType,
	compileCoarse,
	type CompileFailure,
	type CompileResult,
	type CompileSuccess,
} from "./TaskCompiler.js";
export {
	buildWaves,
	flattenCoarse,
	partitionByParallelGroup,
	type BuildOptions,
	type BuildResult,
	type WaveSlot,
} from "./TaskGraph.js";
export type {
	CoarseDag,
	CoarsePhase,
	CoarseTask,
	TaskContract,
	TaskInputs,
	TaskPathPolicy,
} from "./TaskContract.js";
export {
	extractXmlBlock,
	runTask,
	type TaskResult,
	type TaskRunnerOptions,
	type TaskStatus,
	type WorkerExecutor,
} from "./TaskRunner.js";
export {
	schedule,
	type ScheduleOptions,
	type WaveEvent,
} from "./WaveScheduler.js";
