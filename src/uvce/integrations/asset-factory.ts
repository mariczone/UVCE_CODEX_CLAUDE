/**
 * Optional Asset Factory contracts (blueprint §12). NOT CONNECTED in Milestone 0:
 * - no RunPod / GPT Image / Blender MCP endpoint, schema or credential has been inspected or configured;
 * - real adapters must run SERVER-SIDE (secrets never reach the browser bundle);
 * - generated content must come back as PNG RGBA + metadata and go through the same asset compiler.
 * This module only defines the shape and a disabled provider so the UI can report the state honestly.
 */
export type AssetJobType = 'generate_master_video' | 'track_motion_and_masks' | 'extract_rig_curves' | 'render_layered_rgba';

export interface AssetJobRequest {
  jobType: AssetJobType;
  inputAssetUris: string[];
  prompt?: string;
  options: Record<string, unknown>;
  pipelineVersion: string;
}

export interface AssetJobStatus {
  jobId: string;
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  progress?: number;
  outputUris?: string[];
  error?: string;
}

export interface ProviderHealth {
  state: 'disabled' | 'unconfigured' | 'healthy' | 'unreachable';
  detail: string;
}

export interface AssetFactoryProvider {
  readonly id: string;
  health(): Promise<ProviderHealth>;
  submit(request: AssetJobRequest): Promise<AssetJobStatus>;
  status(jobId: string): Promise<AssetJobStatus>;
  cancel(jobId: string): Promise<void>;
}

export class DisabledAssetFactory implements AssetFactoryProvider {
  readonly id = 'disabled';

  async health(): Promise<ProviderHealth> {
    return { state: 'disabled', detail: 'AI asset pipeline disabled (offline fixture mode). No provider endpoint is configured or probed.' };
  }

  async submit(): Promise<AssetJobStatus> {
    throw new Error('Asset factory is disabled; enable a server-side adapter in a later milestone.');
  }

  async status(jobId: string): Promise<AssetJobStatus> {
    return { jobId, state: 'failed', error: 'asset factory disabled' };
  }

  async cancel(): Promise<void> {}
}
