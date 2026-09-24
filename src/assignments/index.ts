import type { ComponentType } from 'react';
import { ResponsivePseudoScatterPlot } from './week-01/ResponsivePseudoScatterPlot';
import { SummarizeDataset } from './week-02/SummarizeDataset';
import { FirstVisual } from './week-03/FirstVisual';
import { SecondPass } from './week-04/SecondPass';
import { NewInteraction } from './week-05/NewInteraction';

export interface Assignment {
  id: string;
  name: string;
  component: ComponentType;
}

export const assignments: Assignment[] = [
  {
    id: '1',
    name: 'Week 1',
    component: ResponsivePseudoScatterPlot,
  },
  {
    id: '2',
    name: 'Week 2',
    component: SummarizeDataset,
  },
  {
    id: '3',
    name: 'Week 3',
    component: FirstVisual,
  },
  {
    id: '4',
    name: 'Week 4',
    component: SecondPass,
  },
  {
    id: '5',
    name: 'Week 5',
    component: NewInteraction,
  }
];

export const assignmentsMap = new Map(assignments.map((ex) => [ex.id, ex]));

export const defaultAssignment = '2';
