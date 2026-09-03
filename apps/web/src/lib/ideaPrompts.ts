/**
 * Directions for teams who arrive without an idea. Grouped the way the
 * organisers wrote them; copy lightly tidied, voice kept.
 */
export type IdeaPrompt = {
  title: string;
  detail: string | null;
};

export type IdeaPromptSection = {
  title: string;
  prompts: readonly IdeaPrompt[];
};

export const ideaPromptSections: readonly IdeaPromptSection[] = [
  {
    title: "Open problems",
    prompts: [
      {
        title: "What comes after pull requests?",
        detail:
          "Pull requests work well for small teams, but they become difficult when many people or agents work in parallel. Design a better collaboration and review model for modern software teams.",
      },
      {
        title: "What is my subagent doing?",
        detail:
          "When agents create subagents, run tools, edit files, and make decisions across long sessions, it becomes hard to understand what happened. Build tracing and debugging tools for agent workflows.",
      },
      {
        title: "Better distributed inference across GPUs",
        detail:
          "A lot of work focuses on reducing token usage. Explore better ways to split models and workloads across multiple GPUs, especially when the hardware is not identical.",
      },
      {
        title: "Offline UPI payments",
        detail: "The tech exists. The UX sucks. Fix this problem.",
      },
      {
        title: "A universal sync engine",
        detail: "One that works everywhere: any database, ORM, or language.",
      },
      {
        title: "Reproducible development environments without Docker",
        detail:
          "Docker is useful, but it is not the only way to reproduce a development environment. Build a simple Nix-based system that works consistently across operating systems.",
      },
      {
        title: "A game where each stage changes one fundamental rule",
        detail: null,
      },
    ],
  },
  {
    title: "Strong technical ideas",
    prompts: [
      {
        title: "A better library for WebTransport",
        detail:
          "WebTransport provides powerful networking primitives in the browser, but the API is still fairly low-level. Build a simpler abstraction for streams, datagrams, RPC, rooms, reconnection, or state sync.",
      },
      {
        title: "A native desktop framework with React-like APIs",
        detail:
          "Build a React-style framework on top of GPUI, Iced, Slint, or another native UI toolkit. The goal is a good developer experience without Electron.",
      },
      {
        title: "A debugger for agent harnesses",
        detail:
          "Make it easy to understand why an agent made a decision, which context influenced it, which tools were called, and where a run failed.",
      },
      {
        title: "A minimal service mesh for mTLS only",
        detail:
          "Modern service meshes provide many features and can consume significant resources. Explore a very small sidecar whose only job is transparent zero-trust mTLS.",
      },
      {
        title: "DeFi risk across protocols",
        detail:
          "Most risk tools evaluate positions individually. Build a system that models dependencies between lending markets, bridges, collateral, liquidity pools, derivatives, and oracles to show possible cascading failures.",
      },
      {
        title: "JSX-like UI directly inside Rust or Go",
        detail:
          "Explore a way to write typed XML or JSX-style interfaces and Tailwind-like styles directly in Rust or Go without introducing a separate templating language.",
      },
      {
        title: "rainbolt.ai",
        detail: "A website that solves GEOINT challenges for you.",
      },
      {
        title: "Ethical prediction markets",
        detail: null,
      },
    ],
  },
  {
    title: "Product and developer experience",
    prompts: [
      {
        title: "“npm i forms”",
        detail: null,
      },
      {
        title: "Better live captions",
        detail:
          "Build captions that understand speakers, technical terms, language switching, interruptions, and conversation context rather than only converting speech to text.",
      },
      {
        title: "Better couch co-op games",
        detail:
          "Build simple multiplayer games designed around people being in the same room, with phones or browsers acting as controllers.",
      },
      {
        title: "Games built around a friend group",
        detail:
          "Use photos, shared memories, music, or other user-provided context to create lightweight party games that feel personal to the people playing them.",
      },
      {
        title: "Improve one part of Notion",
        detail:
          "Instead of rebuilding Notion, choose one area such as offline support, search, databases, writing, or collaboration and make it significantly better.",
      },
      {
        title: "A better free email client",
        detail:
          "Build a fast, local-first email client with strong search, keyboard navigation, offline support, and a clean interface.",
      },
      {
        title: "Rethink the email inbox",
        detail:
          "Email contains tasks, documents, conversations, commitments, and projects, but most clients still present everything as a list of messages. Explore a better model.",
      },
      {
        title: "Personal finance before the mistake happens",
        detail:
          "Most finance apps explain spending after the fact. Build something that understands cash flow and upcoming obligations well enough to warn users before a risky financial decision.",
      },
    ],
  },
  {
    title: "Additional directions",
    prompts: [
      {
        title: "Spawning subagents, properly",
        detail:
          "We still haven’t figured out how to spawn subagents, or how to make them efficient.",
      },
      {
        title: "A lightweight alternative to Electron",
        detail:
          "Explore whether desktop applications can have web-like development speed while using native rendering, lower memory usage, and smaller binaries.",
      },
    ],
  },
];
