import { useRef, useState, useEffect } from 'react';

const SECTIONS = [
  { id: 'overview', label: 'Overview' },
  { id: 'agents', label: 'Agents' },
  { id: 'canvas', label: 'Canvas Workflows' },
  { id: 'goals', label: 'Goals & Projects' },
  { id: 'heartbeat', label: 'Heartbeat Scheduler' },
  { id: 'learnings', label: 'Workflow Learnings' },
  { id: 'decisions', label: 'Decision Steps' },
  { id: 'outputs', label: 'Typed Outputs' },
  { id: 'connectors', label: 'Connectors' },
  { id: 'permissions', label: 'Permissions & Trust' },
  { id: 'machines', label: 'Machines & Launch' },
];

function FeatureCard({ name, desc }: { name: string; desc: string }) {
  return (
    <div className="bg-white/[0.03] border border-white/[0.06] rounded-lg p-3 mb-2">
      <p className="text-[12px] font-medium text-gray-300">{name}</p>
      <p className="text-[12px] text-gray-500 mt-0.5">{desc}</p>
    </div>
  );
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-sm font-semibold text-gray-200 mb-3 border-l-2 border-violet-500 pl-3">
      {children}
    </h2>
  );
}

function BodyText({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[13px] text-gray-400 leading-relaxed mb-4">{children}</p>
  );
}

export function GuideModal({ onClose }: { onClose: () => void }) {
  const sectionRefs = useRef<HTMLDivElement[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const contentRef = useRef<HTMLDivElement>(null);
  const observerActiveIndex = useRef<number>(0);

  // IntersectionObserver to track active section while scrolling
  useEffect(() => {
    const observers: IntersectionObserver[] = [];

    sectionRefs.current.forEach((el, i) => {
      if (!el) return;
      const obs = new IntersectionObserver(
        ([entry]) => {
          if (entry.isIntersecting) {
            observerActiveIndex.current = i;
            setActiveIndex(i);
          }
        },
        {
          root: contentRef.current,
          rootMargin: '-10% 0px -70% 0px',
          threshold: 0,
        }
      );
      obs.observe(el);
      observers.push(obs);
    });

    return () => {
      observers.forEach((o) => o.disconnect());
    };
  }, []);

  // Close on Escape key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const scrollToSection = (index: number) => {
    const el = sectionRefs.current[index];
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    setActiveIndex(index);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-12">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative bg-[#0d0d0f] border border-white/10 rounded-2xl shadow-2xl w-full max-w-4xl max-h-[80vh] flex overflow-hidden">
        {/* Left sidebar */}
        <div className="w-48 flex-shrink-0 border-r border-white/[0.07] bg-black/20 py-4 overflow-y-auto">
          <p className="text-[10px] uppercase tracking-widest text-gray-600 font-semibold px-4 mb-3">
            Guide
          </p>
          {SECTIONS.map((section, i) => (
            <button
              key={section.id}
              onClick={() => scrollToSection(i)}
              className={`w-full text-left text-[12px] px-4 py-1.5 cursor-pointer transition-colors ${
                activeIndex === i
                  ? 'text-violet-400 bg-violet-500/10'
                  : 'text-gray-500 hover:text-gray-300 hover:bg-white/[0.03]'
              }`}
            >
              {section.label}
            </button>
          ))}
        </div>

        {/* Content area */}
        <div ref={contentRef} className="flex-1 overflow-y-auto p-6">
          {/* Header row */}
          <div className="flex items-start justify-between mb-6">
            <div>
              <h1 className="text-base font-semibold text-white">How NeonCore Works</h1>
              <p className="text-[12px] text-gray-600 mt-0.5">Visual AI labor control plane for Claude Code</p>
            </div>
            <button
              onClick={onClose}
              className="text-gray-600 hover:text-gray-300 transition-colors ml-4 flex-shrink-0 mt-0.5"
              aria-label="Close guide"
            >
              {/* X icon */}
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M2 2L14 14M14 2L2 14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
          </div>

          {/* ── Section 0: Overview ── */}
          <div
            ref={(el) => { if (el) sectionRefs.current[0] = el; }}
            className="mb-8 scroll-mt-4"
          >
            <SectionHeader>Overview</SectionHeader>
            <BodyText>
              NeonCore is a visual AI labor control plane for coding-agent power users. Connect your
              agents — Claude, Codex, and Gridlight run side by side, even in the same repo — build structured
              multi-step workflows on a canvas, put two agents on one job with Confer, and track AI work against
              business goals with budget awareness.
            </BodyText>
            <BodyText>
              Mental model: You set goals → create projects → run structured workflows → capture learnings →
              schedule recurring runs. Over time, each run benefits from what previous runs learned.
            </BodyText>
          </div>

          {/* ── Section 1: Agents ── */}
          <div
            ref={(el) => { if (el) sectionRefs.current[1] = el; }}
            className="mb-8 scroll-mt-4"
          >
            <SectionHeader>Agents</SectionHeader>
            <BodyText>
              Agents are coding-agent sessions (Claude, Codex, Gridlight, …) registered with NeonCore via
              hooks — e.g. a PreToolUse hook in your{' '}
              <code className="text-[12px] bg-white/[0.06] text-violet-300 rounded px-1 py-0.5">~/.claude/settings.json</code>
              {' '}(Codex uses <code className="text-[12px] bg-white/[0.06] text-violet-300 rounded px-1 py-0.5">~/.codex</code>).
              Each agent card shows its <strong className="text-gray-300 font-medium">tool</strong>, status
              (working / idle / waiting / offline), repo, branch, and trust mode. Relay-launched agents also
              auto-get the NeonCore MCP (coordination + confer tools).
            </BodyText>
            <p className="text-[12px] font-medium text-gray-400 mb-2">Trust modes</p>
            <FeatureCard name="Manual" desc="You approve every tool use via the Permissions panel." />
            <FeatureCard name="Trust" desc="Tools run automatically without approval." />
            <FeatureCard name="Plan" desc="Agent produces a plan before executing." />
            <p className="text-[12px] font-medium text-gray-400 mt-4 mb-2">Agent types supported</p>
            <div className="flex flex-wrap gap-2 mb-4">
              {['Claude Code', 'Codex', 'Gridlight', 'Amazon Q', 'Cursor'].map((t) => (
                <span key={t} className="text-[11px] bg-white/[0.04] border border-white/[0.08] text-gray-400 rounded-md px-2 py-0.5">
                  {t}
                </span>
              ))}
            </div>
            <p className="text-[12px] font-medium text-gray-400 mt-4 mb-2">Confer — two agents, one job</p>
            <BodyText>
              Pick 2+ live cartridges (e.g. Claude + Codex in one project — one click via the quick-pick) and a
              task; they collaborate via the neoncore message/read tools and converge on one solution. Launch it
              from the <strong className="text-gray-300 font-medium">Confer</strong> button in the header.
            </BodyText>
          </div>

          {/* ── Section 2: Canvas Workflows ── */}
          <div
            ref={(el) => { if (el) sectionRefs.current[2] = el; }}
            className="mb-8 scroll-mt-4"
          >
            <SectionHeader>Canvas Workflows</SectionHeader>
            <BodyText>
              V2 Canvas Workflows are step graphs you build visually. Each node is a step with a type.
              Connect steps with dependency arrows to control execution order. Steps at the same dependency
              level run in parallel. Pick the <strong className="text-gray-300 font-medium">project</strong> once
              at launch; each step runs on that tool by default, or set a per-step{' '}
              <strong className="text-gray-300 font-medium">Tool</strong> (Claude / Codex / Gridlight) to fan the
              workflow across engines — with an optional per-step branch (git worktree).
            </BodyText>
            <p className="text-[12px] font-medium text-gray-400 mb-2">Step types</p>
            <FeatureCard
              name="Claude Code"
              desc="Dispatches a natural language prompt to a registered agent."
            />
            <FeatureCard
              name="Quality Gate"
              desc="Auto-checks the previous step's output; retries up to N times or advances."
            />
            <FeatureCard
              name="Review Gate"
              desc="Pauses for human approval with a criteria checklist."
            />
            <FeatureCard
              name="Deliberation"
              desc="Multi-agent parallel thinking; results merged into a summary."
            />
            <FeatureCard
              name="Decision Checkpoint"
              desc="Structured human choice with options, pros/cons, and routing to different next steps."
            />
            <FeatureCard
              name="Command"
              desc="Dispatches a saved command template's prompt to a registered agent."
            />
            <FeatureCard
              name="Connector"
              desc="Integrates with external systems — Slack, GitHub, Linear, HTTP, and more."
            />
            <BodyText>
              To run: click a template → Configure &amp; Run → assign agents → add context → Launch.
            </BodyText>
          </div>

          {/* ── Section 3: Goals & Projects ── */}
          <div
            ref={(el) => { if (el) sectionRefs.current[3] = el; }}
            className="mb-8 scroll-mt-4"
          >
            <SectionHeader>Goals & Projects</SectionHeader>
            <BodyText>
              Goals represent business objectives with a name, success metric, status, and optional budget cap.
              Projects are work areas under a goal, each tied to a primary repo.
            </BodyText>
            <div className="bg-white/[0.03] border border-white/[0.06] rounded-lg p-3 mb-4">
              <p className="text-[12px] font-medium text-gray-400 mb-1">The cascade</p>
              <div className="flex items-center gap-2 flex-wrap">
                {['Goal', 'Project', 'Workflow', 'Step'].map((item, i, arr) => (
                  <span key={item} className="flex items-center gap-2">
                    <span className="text-[12px] text-gray-300 font-medium">{item}</span>
                    {i < arr.length - 1 && (
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="text-gray-600">
                        <path d="M2 6h8M7 3l3 3-3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </span>
                ))}
              </div>
            </div>
            <BodyText>
              Assign any workflow run to a project. Costs are real USD rollups computed from actual token usage
              per session, priced at each model's own rate (shown as "$X spent"). Budget caps appear as
              color-coded progress bars — yellow at 70%, red at 90%.
            </BodyText>
          </div>

          {/* ── Section 4: Heartbeat Scheduler ── */}
          <div
            ref={(el) => { if (el) sectionRefs.current[4] = el; }}
            className="mb-8 scroll-mt-4"
          >
            <SectionHeader>Heartbeat Scheduler</SectionHeader>
            <BodyText>
              Heartbeats are scheduled recurring workflow runs. Each heartbeat ties a workflow template to a
              project on a repeating schedule.
            </BodyText>
            <FeatureCard name="Hourly" desc="Fires once every hour." />
            <FeatureCard name="Daily at HH:MM" desc="Fires once per day at the configured time." />
            <FeatureCard name="Weekly on DAY at HH:MM" desc="Fires once per week on the configured day and time." />
            <BodyText>
              The server polls for due heartbeats every 60 seconds and fires them automatically. A fired
              heartbeat clones the template into a new run, assigns it to the project, and injects recent
              learnings as context. Heartbeats are skipped if the project's goal has a budget cap and the
              project has exceeded it.
            </BodyText>
          </div>

          {/* ── Section 5: Workflow Learnings ── */}
          <div
            ref={(el) => { if (el) sectionRefs.current[5] = el; }}
            className="mb-8 scroll-mt-4"
          >
            <SectionHeader>Workflow Learnings</SectionHeader>
            <BodyText>
              Add a <span className="text-[12px] bg-white/[0.06] text-violet-300 rounded px-1 py-0.5">Capture Learnings</span> connector
              as the last step of any workflow. It synthesizes all completed step results into a project
              learning entry stored in the database.
            </BodyText>
            <BodyText>
              Every future run in the same project auto-injects the 3 most recent learnings into the initial
              context — so agents start each run knowing what past runs discovered, decided, and recommend.
            </BodyText>
            <BodyText>
              View per-project learnings via the "Learnings" button on any project card in the Goals dashboard.
            </BodyText>
          </div>

          {/* ── Section 6: Decision Steps ── */}
          <div
            ref={(el) => { if (el) sectionRefs.current[6] = el; }}
            className="mb-8 scroll-mt-4"
          >
            <SectionHeader>Decision Steps</SectionHeader>
            <BodyText>
              Decision steps pause a workflow and present a structured choice to the human. Configure a
              question with a plain-English ELI10 explanation, the stakes if the wrong option is chosen, and
              two or more options each with a label, description, and an optional recommended choice.
            </BodyText>
            <BodyText>
              The human's chosen option is stored as the step's result. To branch the graph on that choice,
              add routing rules to the step.
            </BodyText>
          </div>

          {/* ── Section 7: Typed Outputs ── */}
          <div
            ref={(el) => { if (el) sectionRefs.current[7] = el; }}
            className="mb-8 scroll-mt-4"
          >
            <SectionHeader>Typed Outputs</SectionHeader>
            <BodyText>
              Attach an <code className="text-[12px] bg-white/[0.06] text-violet-300 rounded px-1 py-0.5">outputSchema</code> to
              any Claude Code step. NeonCore injects structured format instructions into the agent's prompt
              and renders results as a structured panel instead of raw text.
            </BodyText>
            <p className="text-[12px] font-medium text-gray-400 mb-2">Available schemas</p>
            <FeatureCard
              name="Test Results"
              desc="Pass/fail badge, counts, and failed test list."
            />
            <FeatureCard
              name="Code Review"
              desc="Severity breakdown (critical / high / medium / low) with issue list including file:line."
            />
            <FeatureCard
              name="Design Doc"
              desc="Rendered markdown with clear section structure."
            />
          </div>

          {/* ── Section 8: Connectors ── */}
          <div
            ref={(el) => { if (el) sectionRefs.current[8] = el; }}
            className="mb-8 scroll-mt-4"
          >
            <SectionHeader>Connectors</SectionHeader>
            <BodyText>
              Connector steps integrate with external systems at any point in a workflow.
            </BodyText>
            <FeatureCard name="Slack / Discord" desc="Post a message via incoming webhook." />
            <FeatureCard name="GitHub" desc="Create an issue or comment on a PR." />
            <FeatureCard name="Linear" desc="Create or update an issue." />
            <FeatureCard name="HTTP" desc="Generic webhook POST / PUT / GET." />
            <FeatureCard
              name="System Notify"
              desc="OS desktop notification + optional phone push via ntfy."
            />
            <FeatureCard
              name="Capture Learnings"
              desc="Synthesize run results into project memory for future runs."
            />
            <FeatureCard
              name="Save to Project"
              desc="Write completed step results as a Markdown file to {primary_repo}/.neoncore/docs/."
            />
          </div>

          {/* ── Section 9: Permissions & Trust ── */}
          <div
            ref={(el) => { if (el) sectionRefs.current[9] = el; }}
            className="mb-8 scroll-mt-4"
          >
            <SectionHeader>Permissions & Trust</SectionHeader>
            <BodyText>
              When trust mode is <strong className="text-gray-300 font-medium">Manual</strong>, Claude Code routes
              tool permission requests through NeonCore. A notification appears in the bell icon menu. Approve
              or deny — the agent waits for your response (up to ~10 minutes).
            </BodyText>
            <BodyText>
              Set an agent to <strong className="text-gray-300 font-medium">Trust</strong> mode to let tools
              run automatically — except <code className="text-[12px] bg-white/[0.06] text-violet-300 rounded px-1 py-0.5">AskUserQuestion</code> and{' '}
              <code className="text-[12px] bg-white/[0.06] text-violet-300 rounded px-1 py-0.5">ExitPlanMode</code>, which still wait for a human. Useful for agents
              in a controlled project environment where you trust the workflow.
            </BodyText>
          </div>

          {/* ── Section 10: Machines & Launch ── */}
          <div
            ref={(el) => { if (el) sectionRefs.current[10] = el; }}
            className="mb-8 scroll-mt-4"
          >
            <SectionHeader>Machines &amp; Launch</SectionHeader>
            <BodyText>
              Use the <strong className="text-gray-300 font-medium">+ Launch</strong> button in the top bar to
              start a cartridge on any computer running the NeonCore <em>runner</em> — including this one. Pick a
              machine, pick one of its folders, pick a tool, and a real terminal opens on that machine with
              Claude, Codex, or Gridlight running and connected back as a cartridge.
            </BodyText>
            <p className="text-[12px] font-medium text-gray-400 mt-4 mb-2">Add a machine</p>
            <BodyText>
              On the computer you want to launch on, unzip{' '}
              <code className="text-[12px] bg-white/[0.06] text-violet-300 rounded px-1 py-0.5">neoncore-runner.zip</code>{' '}
              and run one command:
            </BodyText>
            <pre className="text-[11px] text-gray-300 bg-black/30 rounded-lg p-3 overflow-auto mb-2 whitespace-pre-wrap leading-relaxed">{`# macOS / Linux
cd runner
./setup.sh --server http://<server-name>.local:4040 --token <TOKEN> --scan ~/code

# Windows (PowerShell)
cd runner
.\\setup.ps1 -Server http://<server-name>.local:4040 -Token <TOKEN> -Scan C:\\code`}</pre>
            <BodyText>
              It installs the status/approval hooks, registers an auto-start service, and appears in{' '}
              <strong className="text-gray-300 font-medium">+ Launch</strong>. Prefer the server's{' '}
              <code className="text-[12px] bg-white/[0.06] text-violet-300 rounded px-1 py-0.5">.local</code> name over
              an IP so it survives address changes.
            </BodyText>
            <p className="text-[12px] font-medium text-gray-400 mt-4 mb-2">Choosing folders</p>
            <FeatureCard name="--scan DIR / -Scan" desc="Adds every git repo directly under a folder (at install)." />
            <FeatureCard name="--repo DIR / -Repo" desc="Adds one folder; repeatable." />
            <FeatureCard name="Interactive prompt" desc="Give neither and setup asks which folders to expose." />
            <p className="text-[12px] font-medium text-gray-400 mt-4 mb-2">Manage folders from here</p>
            <BodyText>
              In <strong className="text-gray-300 font-medium">+ Launch</strong>, click{' '}
              <strong className="text-gray-300 font-medium">Edit folders</strong> on a machine. Remove with ✕, or type
              a path and hit <strong className="text-gray-300 font-medium">Add</strong> (that exact folder) or{' '}
              <strong className="text-gray-300 font-medium">Scan</strong> (every git repo under it). Paths are on that
              machine; ones that don't exist there are ignored. The same controls exist on the mobile app.
            </BodyText>
            <p className="text-[12px] font-medium text-gray-400 mt-4 mb-2">Security &amp; the pairing token</p>
            <BodyText>
              A machine only participates while its runner is running and only launches inside its allowlist. To stop
              random machines registering, set a token once on the server, then pass the same value as{' '}
              <code className="text-[12px] bg-white/[0.06] text-violet-300 rounded px-1 py-0.5">--token</code> on each machine:
            </BodyText>
            <pre className="text-[11px] text-gray-300 bg-black/30 rounded-lg p-3 overflow-auto mb-2 whitespace-pre-wrap leading-relaxed">{`# 1. generate one
openssl rand -hex 24

# 2. set it on the server (once)
curl -X PUT http://<server-name>.local:4040/api/settings \\
  -H 'Content-Type: application/json' \\
  -d '{"machine_pairing_token":"PASTE_THE_TOKEN"}'

# 3. use the same value as --token when installing each runner`}</pre>
          </div>
        </div>
      </div>
    </div>
  );
}
