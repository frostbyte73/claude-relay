import type { Step } from '../work/work-types.js';
import type { StepHandler } from './types.js';
import { openPrHandler } from './open-pr.js';
import { actionHandler } from './action.js';
import { orchestratedHandler } from './orchestrated.js';

const registry: Record<Step['type'], StepHandler<Step>> = {
  'open-pr':      openPrHandler      as unknown as StepHandler<Step>,
  'action':       actionHandler      as unknown as StepHandler<Step>,
  'orchestrated': orchestratedHandler as unknown as StepHandler<Step>,
};

export function handlerFor<S extends Step>(step: S): StepHandler<S> {
  return registry[step.type] as unknown as StepHandler<S>;
}

export function initialStateForType(type: Step['type']): Step['state'] {
  return registry[type].initialState;
}

export { openPrHandler, actionHandler, orchestratedHandler };
