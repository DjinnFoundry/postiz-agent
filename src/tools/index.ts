import { ToolRegistry } from '../core/tool-registry.js';
import { transcribeTool } from './transcribe.js';
import { moderateCaptionsTool } from './moderate-captions.js';
import { renderSlideVideoTool } from './render-slide-video.js';
import { resolveThemeTool, chooseThemeTool } from './resolve-theme.js';

/**
 * Bootstrap every built-in tool onto a registry. External code (CLI, agents,
 * tests) can extend this with their own tools before running a pipeline.
 */
export function createDefaultRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry
    .register(transcribeTool)
    .register(moderateCaptionsTool)
    .register(renderSlideVideoTool)
    .register(resolveThemeTool)
    .register(chooseThemeTool);
  return registry;
}

export { transcribeTool, moderateCaptionsTool, renderSlideVideoTool, resolveThemeTool, chooseThemeTool };
