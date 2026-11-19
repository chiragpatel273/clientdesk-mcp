export type Role = 'partner' | 'assistant';

/** The signed-in staff member a request runs as. Every tool receives one. */
export interface Actor {
  staffId: string;
  name: string;
  email: string;
  role: Role;
  /** The public demo visitor: may read like a partner, may never change anything (enforced in /api and runTool). */
  readOnly: boolean;
}
