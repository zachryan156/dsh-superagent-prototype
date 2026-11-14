/** Tests the rendered user systemd unit for dsh-superagent. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const unit = readFileSync(join(import.meta.dirname, '..', 'deploy', 'dsh-superagent.service.in'), 'utf8')

it('gives the user systemd service dsh and preserves intentional-stop recovery', () => {
  expect(unit).toContain('Environment=PATH=@DSH_BIN@:@PATH@')
  expect(unit).toContain('SuccessExitStatus=2 3')
  expect(unit).toContain('ConditionPathExists=!@CONTROL@/manually-stopped')
  expect(unit).toContain('ExecStart="@ROOT@/scripts/dsh-superagent" --profile %i --url @URL@ start --respect-stop')
  expect(unit).toContain('ExecStop="@ROOT@/scripts/dsh-superagent" --profile %i --url @URL@ --no-stop-marker stop')
})
