import { describe, expect, it } from 'vitest'

import { toDriveAction, validateRoverAction } from './validateRoverAction'

describe('validateRoverAction', () => {
  it('passes valid actions through unclipped', () => {
    expect(validateRoverAction({ leftDrive: 1, rightDrive: -1 })).toEqual({ left: 1, right: -1, clipped: false })
    expect(validateRoverAction({ leftDrive: 0, rightDrive: 0 })).toEqual({ left: 0, right: 0, clipped: false })
  })

  it('clips finite out-of-range efforts and reports it', () => {
    expect(validateRoverAction({ leftDrive: 2, rightDrive: -3 })).toEqual({ left: 1, right: -1, clipped: true })
    expect(validateRoverAction({ leftDrive: 0.5, rightDrive: 1.2 })).toEqual({ left: 0.5, right: 1, clipped: true })
  })

  it.each([
    ['null', null],
    ['string', 'forward'],
    ['number', 1],
    ['empty object', {}],
    ['missing rightDrive', { leftDrive: 0 }],
    ['NaN', { leftDrive: Number.NaN, rightDrive: 0 }],
    ['Infinity', { leftDrive: 0, rightDrive: Number.POSITIVE_INFINITY }],
    ['string field', { leftDrive: '1', rightDrive: 0 }],
  ])('throws on malformed action (%s)', (_label, action) => {
    expect(() => validateRoverAction(action)).toThrow()
  })

  it('maps to a DriveAction with brake and eStop off', () => {
    expect(toDriveAction({ left: 0.5, right: -0.5, clipped: false })).toEqual({
      left: 0.5,
      right: -0.5,
      brake: false,
      eStop: false,
    })
  })
})
