/**
 * Optional GPU timing via EXT_disjoint_timer_query_webgl2. Reports null when unsupported or disjoint.
 * NOTE: on software rasterizers (e.g. SwiftShader in headless CI) this measures CPU rasterisation, not a GPU;
 * the UI always shows the GL renderer string next to the number.
 */
export class GpuTimer {
  private readonly gl: WebGL2RenderingContext;
  private readonly ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
  private readonly pending: WebGLQuery[] = [];
  private active: WebGLQuery | null = null;
  lastMs: number | null = null;
  /** Called once per resolved query (not per frame): no duplicated samples. */
  onResult: ((ms: number) => void) | null = null;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
  }

  get supported(): boolean {
    return this.ext !== null;
  }

  begin(): void {
    if (!this.ext || this.active || this.pending.length > 4) return;
    const q = this.gl.createQuery();
    if (!q) return;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.active = q;
  }

  end(): void {
    if (!this.ext || !this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;
    this.poll();
  }

  private poll(): void {
    if (!this.ext) return;
    while (this.pending.length > 0) {
      const q = this.pending[0] as WebGLQuery;
      if (!this.gl.getQueryParameter(q, this.gl.QUERY_RESULT_AVAILABLE)) break;
      const disjoint = this.gl.getParameter(this.ext.GPU_DISJOINT_EXT) as boolean;
      const ns = this.gl.getQueryParameter(q, this.gl.QUERY_RESULT) as number;
      this.lastMs = disjoint ? null : ns / 1e6;
      if (this.lastMs !== null) this.onResult?.(this.lastMs);
      this.gl.deleteQuery(q);
      this.pending.shift();
    }
  }
}
