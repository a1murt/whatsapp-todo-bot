export class LLMExtractionError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'LLMExtractionError';
  }
}

export class TaskSinkError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'TaskSinkError';
  }
}
