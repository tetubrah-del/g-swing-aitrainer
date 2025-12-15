import { User, UserAction, UserPlan } from '@/types/user';

const getEffectivePlan = (user: User): UserPlan => {
  const monitorActive =
    user.isMonitor === true &&
    user.monitorExpiresAt != null &&
    user.monitorExpiresAt.getTime() > Date.now();

  return monitorActive ? 'pro' : user.plan;
};

export const canPerform = (user: User, action: UserAction): boolean => {
  const plan = getEffectivePlan(user);

  switch (action) {
    case 'analyze_swing':
    case 'use_ai_coach':
      return true;
    case 'unlimited_analysis':
      return plan === 'pro';
    case 'view_history_list':
      return plan === 'free' || plan === 'pro';
    case 'view_history_graph':
      return plan === 'pro';
    default: {
      const exhaustiveCheck: never = action;
      return exhaustiveCheck;
    }
  }
};

export { getEffectivePlan };
