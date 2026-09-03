import { useState } from 'react';
import {
  Bar,
  Banner,
  Button,
  Card,
  Checkbox,
  DiffRow,
  Field,
  HunkHeader,
  LivenessDot,
  MetaChip,
  Modal,
  Radio,
  Segmented,
  SeverityChip,
  StateKicker,
  Stepper,
  Table,
  Tabs,
  TruncationBand,
} from './design';

/**
 * Every component in every state, on one page.
 *
 * This is the acceptance test for the design system and it is meant to be run
 * against, not just looked at: `npm run audit:contrast` walks the rendered
 * markup with a background stack and checks every coloured string against its
 * actual enclosing ground at its real size and weight. The bundle held zero
 * failures across 1,122 elements and this has to as well.
 */

function Section({ n, title, note, children }: { n: string; title: string; note?: string; children: React.ReactNode }) {
  return (
    <section style={{ marginTop: 'var(--space-7)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-4)', marginBottom: 'var(--space-5)' }}>
        <span className="v-label">{n}</span>
        <span className="v-section">{title}</span>
        {note !== undefined && <span className="v-body-sm">{note}</span>}
      </div>
      {children}
    </section>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 'var(--space-4)', alignItems: 'center', flexWrap: 'wrap', marginBottom: 'var(--space-4)' }}>
      {children}
    </div>
  );
}

export function Gallery() {
  const [seg, setSeg] = useState('stop');
  const [tab, setTab] = useState('findings');
  const [modal, setModal] = useState(false);

  return (
    <main
      style={{
        background: 'var(--surface-page)',
        minHeight: '100vh',
        padding: 'var(--space-7) var(--space-6) var(--space-8)',
      }}
    >
      <div style={{ maxWidth: 1080, margin: '0 auto' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-end',
            gap: 'var(--space-5)',
            paddingBottom: 'var(--space-5)',
            borderBottom: '1px solid var(--rule-structure)',
          }}
        >
          <span className="v-label">vibe · desktop</span>
          <span className="v-display">Design system</span>
          <span className="v-body-sm" style={{ maxWidth: 460 }}>
            Sixteen components and the six states the screens never had to draw. Transcribed from the build
            spec; no hex appears outside tokens.css.
          </span>
        </div>

        <Section n="01" title="Severity" note="a ramp with an order · no chip carries a fill">
          <Row>
            <SeverityChip severity="P0" count={2} />
            <SeverityChip severity="P1" count={3} />
            <SeverityChip severity="P2" count={4} />
            <SeverityChip severity="P3" count={1} />
            <SeverityChip severity={null} count={0} label="none" />
          </Row>
        </Section>

        <Section n="02" title="Kickers" note="the one place a solid fill is not interactive">
          <Row>
            <StateKicker tone="alarm">halted</StateKicker>
            <StateKicker tone="alarm">stale</StateKicker>
            <StateKicker tone="accent">waiting on you</StateKicker>
            <StateKicker tone="quiet">inert turn</StateKicker>
            <StateKicker tone="quiet">still asking</StateKicker>
          </Row>
        </Section>

        <Section n="03" title="Meta chips" note="dashed unless the kind is checkable">
          <Row>
            <MetaChip>unknown</MetaChip>
            <MetaChip>likely the same</MetaChip>
            <MetaChip>app</MetaChip>
            <MetaChip kind="proposed">proposed · #140</MetaChip>
            <MetaChip kind="checkable">code · src/auth.ts:41</MetaChip>
            <MetaChip kind="checkable">artifact · code-review-2.json</MetaChip>
            <MetaChip>external · no path</MetaChip>
          </Row>
        </Section>

        <Section n="04" title="Buttons" note="three levels · one primary per region · hover, active, disabled">
          <Row>
            <Button level="primary">Approve plan</Button>
            <Button level="secondary">Hold here</Button>
            <Button level="tertiary">Fix myself</Button>
            <Button level="secondary" disabled>
              Defer · P2/P3 only
            </Button>
          </Row>
          <span className="v-body-sm">
            Disabled is the dashed absence treatment, never a dimming — it says <em>decided</em> where
            dimming would say <em>off</em>.
          </span>
        </Section>

        <Section n="05" title="Fields" note="rest · empty · locked · with unit and steppers">
          <Row>
            <Field value="5" unit="rounds" />
            <Field value="" state="empty" unit="not set" />
            <Field value="25000000" state="locked" unit="tokens" />
            <span style={{ display: 'flex', alignItems: 'center' }}>
              <Field value="3" unit="runs" />
              <Stepper />
            </span>
          </Row>
        </Section>

        <Section n="06" title="Radio, checkbox, segmented" note="square marks · the only toggle in the system">
          <Row>
            <Radio on />
            <Radio on={false} />
            <Radio on locked />
            <Checkbox on />
            <Checkbox on={false} />
            <Checkbox on locked />
          </Row>
          <Row>
            <Segmented
              value={seg}
              onChange={setSeg}
              cells={[
                { value: 'auto', label: 'auto' },
                { value: 'stop', label: 'stop' },
                { value: 'step', label: 'step', unavailable: true },
              ]}
            />
            <span className="v-body-sm">`step` is unavailable by rule on this boundary, so it is dashed.</span>
          </Row>
        </Section>

        <Section n="07" title="Tabs" note="counts are tertiary unless the tab is active">
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              { value: 'code', label: 'Code' },
              { value: 'findings', label: 'Findings', count: 7 },
              { value: 'verify', label: 'Verify', count: 3 },
              { value: 'log', label: 'Log' },
            ]}
          />
        </Section>

        <Section n="08" title="Liveness" note="four states, because an unanswerable probe is not death">
          <Row>
            <LivenessDot state="live" />
            <span className="v-body-sm">live · pulsing</span>
            <LivenessDot state="quiet" />
            <span className="v-body-sm">quiet · still working</span>
            <LivenessDot state="waiting" />
            <span className="v-body-sm">waiting on you · not stalled</span>
            <LivenessDot state="absent" />
            <span className="v-body-sm">pid 48213 · cannot tell</span>
          </Row>
        </Section>

        <Section n="09" title="Bars" note="quantity ramp only · never a bar at 0%">
          <div style={{ display: 'grid', gap: 'var(--space-4)', maxWidth: 420 }}>
            <Bar segments={[{ share: 0.62, step: 1 }, { share: 0.24, step: 2 }, { share: 0.14, step: 3 }]} />
            <Bar segments={[{ share: 0.41, step: 2 }]} />
            <Bar segments={null} />
          </div>
          <div className="v-body-sm" style={{ marginTop: 'var(--space-3)' }}>
            The third is not empty — it is unmeasurable, and drawn dashed over the hatch so the two cannot be
            confused.
          </div>
        </Section>

        <Section n="10" title="Cards" note="settled · live · spent · severity-ruled">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 'var(--space-5)', maxWidth: 720 }}>
            <Card>
              <div className="v-label">cycle 1 · plan</div>
              <div className="v-lead" style={{ marginTop: 'var(--space-2)' }}>Plan approved after two revisions.</div>
            </Card>
            <Card state="live">
              <div className="v-label">cycle 2 · review</div>
              <div className="v-lead" style={{ marginTop: 'var(--space-2)' }}>Reading the diff · 34 tool calls</div>
            </Card>
            <Card state="spent">
              <div className="v-label">F-06 · declined</div>
              <div className="v-body-sm" style={{ marginTop: 'var(--space-2)' }}>house style, not a defect</div>
            </Card>
            <Card severity="P0">
              <div className="v-label">F-01 · src/run.ts:412</div>
              <div className="v-lead" style={{ marginTop: 'var(--space-2)' }}>
                A crash between write and rename leaves an unusable state file.
              </div>
            </Card>
          </div>
        </Section>

        <Section n="11" title="Table" note="30px header · 34px rows · no zebra · sized to content">
          <Table
            columns={['boundary', 'mode', 'cap']}
            selected="verify-round"
            rows={[
              { key: 'plan-round', cells: ['plan-round', 'auto', '5'] },
              { key: 'plan-approved', cells: ['plan-approved', 'stop', '—'] },
              { key: 'implemented', cells: ['implemented', 'auto', '—'] },
              { key: 'verify-round', cells: ['verify-round', 'stop', '3'] },
              { key: 'review-round', cells: ['review-round', 'auto', '5'] },
            ]}
          />
        </Section>

        <Section n="12" title="Diff" note="ratio answers visibility; hue answers added-or-removed">
          <div className="v-diff" style={{ maxWidth: 720, border: '1px solid var(--rule-card)' }}>
            <HunkHeader>@@ src/run.ts · lines 39–43 @@</HunkHeader>
            <DiffRow kind="context" newNo={38} code="  const tmp = `${path}.partial`;" />
            <DiffRow kind="removed" newNo={39} code="  await fs.writeFile(path, body);" />
            <DiffRow kind="added" newNo={40} code="  await fs.writeFile(tmp, body);" />
            <DiffRow kind="added" newNo={41} code="  await fs.rename(tmp, path);" />
            <DiffRow kind="context" newNo={42} code="  return path;" />
            <TruncationBand>
              The diff it was handed stopped here; it holds <code>Read · Glob · Grep · Bash</code> and went
              looking. <strong>34 tool calls after this point.</strong>
            </TruncationBand>
          </div>
        </Section>

        <Section n="13" title="Banner" note="replaces the footer in place · never above it">
          <Banner
            kicker={<StateKicker tone="alarm">oscillation</StateKicker>}
            headline="The same finding has returned three rounds running."
            evidence="F-04 · src/orchestrator.ts:1180 · rounds 2, 3, 4"
            actions={
              <>
                <Button level="tertiary">Show the three</Button>
                <Button level="primary">Decide it myself</Button>
              </>
            }
          />
        </Section>

        <Section n="14" title="Modal" note="two instances in the product, so it carries the only shadow">
          <Row>
            <Button level="secondary" onClick={() => setModal(true)}>
              Open the modal
            </Button>
          </Row>
          {modal && (
            <Modal>
              <div className="v-title">Quit while a turn is running?</div>
              <p className="v-lead" style={{ marginTop: 'var(--space-4)' }}>
                Quitting kills them. Their conversations survive — resuming continues each by session id — but
                the work each turn has done so far is discarded and paid for again.
              </p>
              <div style={{ display: 'flex', gap: 'var(--space-3)', marginTop: 'var(--space-6)' }}>
                <Button level="primary" onClick={() => setModal(false)}>
                  Hide instead
                </Button>
                <Button level="secondary" onClick={() => setModal(false)}>
                  Quit anyway
                </Button>
              </div>
            </Modal>
          )}
        </Section>

        <Section n="15" title="The two rules most likely to slip">
          <Card>
            <p className="v-body">
              <strong>The text floor.</strong> <code className="v-mono">#8f9498</code> is the last passing step
              on these grounds. Anything dimmer is a border, not text — recession below it is built with size
              and weight.
            </p>
            <p className="v-body" style={{ marginTop: 'var(--space-4)' }}>
              <strong>Solid fill means interactive.</strong> The one exception is the single state label that
              leads a banner. Never two solids of the same fill in one region.
            </p>
          </Card>
        </Section>
      </div>
    </main>
  );
}
