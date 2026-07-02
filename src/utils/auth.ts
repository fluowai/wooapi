export type AccountType = 'owner' | 'reseller' | 'client' | 'whitelabel_reseller';
export type UserRole = 'super_admin' | 'user';

export interface AuthData {
  accountId: number;
  user: { role: UserRole; name: string; email: string; [key: string]: any };
  account?: { account_type: AccountType; status?: string; trial_ends_at?: string; [key: string]: any };
  token: string;
  originalAuth?: AuthData;
}

export function isSuperAdmin(auth: AuthData | null): boolean {
  return auth?.user?.role === 'super_admin';
}

export function accountType(auth: AuthData | null): AccountType | undefined {
  return auth?.account?.account_type;
}

export function isReseller(auth: AuthData | null): boolean {
  const t = accountType(auth);
  return t === 'owner' || t === 'reseller' || t === 'whitelabel_reseller';
}

export function canManageClients(auth: AuthData | null): boolean {
  return isSuperAdmin(auth) || isReseller(auth);
}

export function isImpersonating(auth: AuthData | null): boolean {
  return !!auth?.originalAuth;
}
