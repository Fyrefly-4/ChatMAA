import type { RuntimeService } from './service.ts';

// Public in-process D5 contract; SDK request/response types do not cross this boundary.
export type MessageInput = { conversationId: string; messageId: string; text: string };
export type TurnView = ReturnType<RuntimeService['read']>;
export type ConversationView = ReturnType<RuntimeService['conversation']>;
export type RuntimeStatus = ReturnType<RuntimeService['status']>;
export type { Turn, Activity } from './records.ts';
