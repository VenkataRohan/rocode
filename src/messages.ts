// The agent's own, Provider-independent conversation model.
// Providers translate to and from these shapes; nothing here knows about any wire format.

export type Usage = {
  inputTokens: number;
  outputTokens: number;
};

/** A request from the Model to run a Tool with specific arguments. */
export type ToolCall = {
  id: string;
  name: string;
  /** Already parsed from the Provider's wire format; null when they weren't valid JSON. */
  arguments: unknown;
  /** The Model's raw argument text, present only when it wasn't valid JSON. */
  unparsedArguments?: string;
};

export type UserMessage = {
  role: "user";
  content: string;
};

export type AssistantMessage = {
  role: "assistant";
  content: string;
  toolCalls: ToolCall[];
  /** True when the user cancelled the Turn while this Message was streaming. */
  interrupted?: boolean;
  usage?: Usage;
};

/** The output (or error) of executing a Tool Call, sent back to the Model. */
export type ToolResultMessage = {
  role: "tool_result";
  toolCallId: string;
  toolName: string;
  content: string;
  isError: boolean;
};

export type Message = UserMessage | AssistantMessage | ToolResultMessage;
