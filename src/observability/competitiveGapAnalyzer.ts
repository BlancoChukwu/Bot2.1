import type { PipelineObservedOutcome } from "../orchestrator/pipelineOrchestrator";

export interface CompetitiveGapSample {
  readonly opportunityId: string;
  readonly chain: string;
  readonly outcome: PipelineObservedOutcome;
  readonly recordedAtMs: number;
}

export class CompetitiveGapAnalyzer {
  private readonly samples: CompetitiveGapSample[] = [];

  public record(sample: CompetitiveGapSample): void {
    this.samples.push(sample);
    this.prune(sample.recordedAtMs - 48 * 60 * 60 * 1000);
  }

  public sameBlockWouldBeRatio(): number {
    const detected = this.samples.filter((sample) => sample.outcome !== "reverted");
    if (detected.length === 0) {
      return 0;
    }
    const wonOrSent = detected.filter((sample) => sample.outcome === "won").length;
    return wonOrSent / detected.length;
  }

  public summary() {
    const detected = this.samples.filter((sample) => sample.outcome !== "reverted").length;
    const won = this.samples.filter((sample) => sample.outcome === "won").length;
    const lostToCompetitor = this.samples.filter((sample) => sample.outcome === "lost_to_competitor").length;
    return {
      detected,
      won,
      lostToCompetitor,
      sameBlockWouldBeRatio: this.sameBlockWouldBeRatio(),
    };
  }

  private prune(cutoffMs: number): void {
    while (this.samples.length > 0) {
      const oldest = this.samples[0];
      if (oldest === undefined || oldest.recordedAtMs >= cutoffMs) {
        break;
      }
      this.samples.shift();
    }
  }
}

