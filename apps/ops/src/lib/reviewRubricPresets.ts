export type CriterionDraft = {
  id: string;
  stableKey: string;
  label: string;
  question: string;
  guidance: string;
  weight: string;
  anchors: {
    zero: string;
    one: string;
    two: string;
    three: string;
    four: string;
  };
};

function criterion(
  stableKey: string,
  label: string,
  weight: number,
  question: string,
  guidance: string,
  anchors: [string, string, string, string, string],
): CriterionDraft {
  const [zero, one, two, three, four] = anchors;
  return {
    id: `criterion-${stableKey}`,
    stableKey,
    label,
    question,
    guidance,
    weight: String(weight),
    anchors: { zero, one, two, three, four },
  };
}

export const reviewRubricPresets = {
  round1: {
    name: "Round 1 · Idea and execution",
    overallWeight: 30,
    criteria: [
      criterion(
        "research_scope",
        "Research & Scope",
        30,
        "What research validates the problem, and who and what are in scope?",
        "Look for research examples, understanding of the problem, a bounded scope, and a specific target audience.",
        [
          "No research or defined scope; only unsupported generic claims.",
          "A problem is stated, but research and scope are weak.",
          "Some relevant research and a basic audience or scope are shown.",
          "Research supports a clear problem, audience, and mostly complete scope.",
          "Researched validation examples, complete understanding, and a clearly defined scope and target audience.",
        ],
      ),
      criterion(
        "user_readiness",
        "User Readiness",
        20,
        "Can the intended user follow the current experience, and what is ready to use?",
        "Assess UI, UX, the main flow, readiness, and demonstrated deliverables.",
        [
          "No usable flow or deliverables; only claims.",
          "Disconnected screens or fragments with major gaps.",
          "The main flow is understandable but partly incomplete.",
          "A coherent usable flow with a few remaining gaps.",
          "A complete, ready flow with UX appropriate to the intended user.",
        ],
      ),
      criterion(
        "idea_novelty",
        "Idea Novelty & Uniqueness",
        15,
        "How does the idea differ from existing approaches, and why is that difference useful?",
        "Judge the team's demonstrated distinction and use case. Do not use the intake novelty number as a judging input.",
        [
          "A common idea with no demonstrated distinction.",
          "Small cosmetic differences with unclear value.",
          "A meaningful difference for an understandable use case.",
          "A strong, useful distinction supported by comparison.",
          "A clearly differentiated idea with an unusually strong use case.",
        ],
      ),
      criterion(
        "technical_execution",
        "Technical Execution",
        25,
        "What is the architecture, why was it chosen, and how does the implementation support it?",
        "Prioritize architecture, its explanation, implementation justification, then necessary complexity. Complexity alone does not earn points.",
        [
          "An unsupported implementation proposal with no architecture or justification.",
          "A basic technical approach with little architectural reasoning.",
          "A plausible architecture and partial justification of implementation choices.",
          "A sound, well-explained architecture with justified implementation choices.",
          "Demonstrated architecture, a complete explanation, justified implementation and stack choices, and appropriate complexity.",
        ],
      ),
      criterion(
        "presentation",
        "Presentation",
        10,
        "Can the team pitch its deliverables and explain each member's contribution?",
        "Prioritize concrete deliverables and the pitch, supported by clear roles and contribution.",
        [
          "No coherent presentation, deliverables, or demonstrated teamwork.",
          "An unclear pitch with weak deliverables and role distribution.",
          "An understandable pitch with some deliverables and roles.",
          "A clear pitch, concrete deliverables, and credible contributions.",
          "A strong pitch, demonstrated deliverables, and a clear role-based distribution of work.",
        ],
      ),
    ],
  },
  round2: {
    name: "Round 2 · Completion and progress",
    overallWeight: 70,
    criteria: [
      criterion(
        "technical_completion",
        "Technical Completion",
        30,
        "How completely did the team implement the architecture and commitments from Round 1?",
        "Follow up on the earlier technical execution, architecture, and promised implementation using the actual evidence.",
        [
          "No meaningful technical completion is demonstrated.",
          "Only isolated fragments work; major commitments are unmet.",
          "A meaningful portion works, with substantial technical gaps.",
          "Most of the intended architecture and core implementation work.",
          "The intended architecture and technical commitments are complete, coherent, and demonstrably working.",
        ],
      ),
      criterion(
        "demo",
        "Demo",
        15,
        "Can the team demonstrate the main flow and clearly communicate how it works?",
        "Assess the demo, walkthrough, presentation, and communication of the idea.",
        [
          "No working demo or understandable walkthrough.",
          "A fragile or unclear demo of isolated parts.",
          "A basic main flow can be demonstrated and explained.",
          "A clear, mostly reliable walkthrough of the important flow.",
          "A reliable end-to-end demo with a clear explanation of the idea and how the product works.",
        ],
      ),
      criterion(
        "reproducibility_deployment",
        "Reproducibility & Deployment",
        20,
        "Can the project be run from its instructions and used in its deployed form?",
        "Inspect setup instructions, dependencies, configuration, reproducibility, and deployment appropriate to the project.",
        [
          "The project cannot be reproduced or run from the supplied material.",
          "Setup or deployment depends on unexplained manual steps.",
          "Basic reproduction is possible, but instructions or deployment have gaps.",
          "Clear setup and a usable deployment with minor limitations.",
          "The submitted instructions reliably reproduce the project and its deployment is usable and explained.",
        ],
      ),
      criterion(
        "design_ux",
        "Design & UX",
        25,
        "What design decisions support the user journey, and how does the team justify them?",
        "Require an explanation of flow, usability, error handling, and accessibility appropriate to the interface.",
        [
          "No coherent user flow or explanation of design decisions.",
          "The flow is confusing and design choices are weakly explained.",
          "A usable main flow with a basic design rationale.",
          "A thoughtful user journey with clear reasoning and few usability gaps.",
          "A coherent, accessible experience with well-justified design decisions and thoughtful handling of the whole flow.",
        ],
      ),
      criterion(
        "growth_progress",
        "Growth, Progress & Future Scope",
        10,
        "What improved since Round 1, what remains weak, and what are the next realistic improvements?",
        "Compare the two review checkpoints and commitments. Reward demonstrated improvement and realistic next steps.",
        [
          "No demonstrated progress or meaningful next steps.",
          "Little progress and mostly vague future claims.",
          "Some demonstrated improvement and plausible next steps.",
          "Clear progress against commitments with specific future improvements.",
          "Substantial verified improvement, thoughtful reflection, and well-prioritized, realistic future scope.",
        ],
      ),
    ],
  },
};
