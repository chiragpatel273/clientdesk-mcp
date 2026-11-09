export type Role = 'partner' | 'assistant';

/** The signed-in staff member a request runs as. Every tool receives one. */
export interface Actor {
  staffId: string;
  name: string;
  email: string;
  role: Role;
}
