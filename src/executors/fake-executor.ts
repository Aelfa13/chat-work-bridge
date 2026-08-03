import type { Executor, ExecutorRequest, ExecutorResult } from "./executor.js";

export class FakeExecutor implements Executor {
  #requests: ExecutorRequest[] = [];

  constructor(private readonly result: ExecutorResult) {}

  async execute(request: ExecutorRequest): Promise<ExecutorResult> {
    this.#requests.push(request);
    return this.result;
  }

  get calls(): ExecutorRequest[] {
    return [...this.#requests];
  }
}
