import { isInternalBuild } from 'src/capabilities/static.js'
import React, { useCallback, useEffect, useMemo } from 'react'
import { Box, Text } from '../ink.js'
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'
import { getAntModelOverrideConfig } from '../utils/model/antModels.js'
import type { OptionWithDescription } from './CustomSelect/select.js'
import { Select } from './CustomSelect/select.js'
import { PermissionDialog } from './permissions/PermissionDialog.js'

type AntModelSwitchCalloutProps = {
  onDone: (selection: string, modelAlias?: string) => void
}

const MODEL_SWITCH_THROTTLE_MS = 24 * 60 * 60 * 1000

function getSwitchCalloutConfig() {
  return getAntModelOverrideConfig()?.switchCallout ?? null
}

export function AntModelSwitchCallout({
  onDone,
}: AntModelSwitchCalloutProps): React.ReactNode {
  const switchCallout = getSwitchCalloutConfig()

  // Record this appearance so repeat surfacing is throttled and version-aware.
  useEffect(() => {
    if (!switchCallout) {
      return
    }

    const shownAt = Date.now()
    saveGlobalConfig(current => ({
      ...current,
      modelSwitchCalloutLastShown: shownAt,
      modelSwitchCalloutVersion: switchCallout.version,
    }))
  }, [switchCallout])

  useEffect(() => {
    if (!switchCallout) {
      onDone('dismiss')
    }
  }, [switchCallout, onDone])

  const handleSelect = useCallback(
    (value: string): void => {
      if (value === 'never') {
        saveGlobalConfig(current => {
          if (current.modelSwitchCalloutDismissed) {
            return current
          }
          return {
            ...current,
            modelSwitchCalloutDismissed: true,
          }
        })
        onDone('dismiss')
        return
      }

      if (value === 'switch' && switchCallout?.modelAlias) {
        onDone('switch', switchCallout.modelAlias)
        return
      }

      onDone('dismiss')
    },
    [onDone, switchCallout],
  )

  const options = useMemo<OptionWithDescription<string>[]>(() => {
    const base: OptionWithDescription<string>[] = [
      {
        label: 'Not now',
        description: 'Keep your current model for now.',
        value: 'dismiss',
      },
      {
        label: "Don't show again",
        description: 'Hide future model switch recommendations.',
        value: 'never',
      },
    ]

    if (switchCallout?.modelAlias) {
      return [
        {
          label: `Switch to ${switchCallout.modelAlias}`,
          description: 'Use the recommended model for future turns.',
          value: 'switch',
        },
        ...base,
      ]
    }

    return base
  }, [switchCallout])

  if (!switchCallout) {
    return null
  }

  return (
    <PermissionDialog title={`Model switch recommendation (${switchCallout.version})`}>
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Box marginBottom={1}>
          <Text>{switchCallout.description}</Text>
        </Box>
        <Select options={options} onChange={handleSelect} onCancel={() => onDone('dismiss')} />
      </Box>
    </PermissionDialog>
  )
}

export function shouldShowModelSwitchCallout(): boolean {
  if (!isInternalBuild()) {
    return false
  }

  const switchCallout = getSwitchCalloutConfig()
  if (!switchCallout) {
    return false
  }

  const config = getGlobalConfig()
  if (config.modelSwitchCalloutDismissed) {
    return false
  }

  const sameVersion = config.modelSwitchCalloutVersion === switchCallout.version
  const lastShown = config.modelSwitchCalloutLastShown ?? 0
  if (sameVersion && lastShown > 0 && Date.now() - lastShown < MODEL_SWITCH_THROTTLE_MS) {
    return false
  }

  return true
}
