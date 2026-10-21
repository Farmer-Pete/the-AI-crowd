export type State = "working" | "permission" | "question" | "error" | "review" | "idle" | "waiting" | "ended";
export type Tier = "urgent" | "review" | "quiet";

export type Helper = { id: string; label: string };

// Two levels of "what is it doing": `title` is what the whole session is about,
// `detail` is the one line for right now. Its meaning follows the state:
// the current action while working, the ask while urgent, the result after a turn.
export type Agent = {
  id: string;
  source: "demo" | "live";
  title: string;
  project: string;
  cwd: string;
  state: State;
  since: number;
  detail: string;
  helpers: Helper[];
  // More about the session, shown on hover: the cmux workspace description, when there is one.
  about?: string;
};

// What the page gets: the agent plus what the server worked out about attention.
export type ViewAgent = Agent & { tier: Tier; label: string };

export type Settings = {
  urgentSound: boolean;
  urgentNotify: boolean;
  tabCount: boolean;
  reviewSound: boolean;
  reviewNotify: boolean;
  sound: "phone" | "beep";
  muted: boolean;
  popBubbles: boolean;
  showDemo: boolean;
  hooksDismissed: boolean;
};
