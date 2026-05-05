export interface SessionState {
  userId: string;
  step: number;
  state: Record<string, unknown>;
  updatedAt: string;
}