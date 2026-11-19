import { useCallback, useEffect } from 'react';
import { useSearchParams } from 'react-router';
import { assignments, assignmentsMap, defaultAssignment } from './assignments';

// The assignments list on the left is kept in the code but not shown. Set this to true to bring it back.
const SHOW_ASSIGNMENT_LIST = false;

function App() {
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedAssignmentId = searchParams.get('example') || defaultAssignment;
  const selectedAssignment = assignmentsMap.get(selectedAssignmentId);
  const SelectedComponent = selectedAssignment?.component;
  const hideSidebar = !SHOW_ASSIGNMENT_LIST || searchParams.has('hideSidebar');

  const handleSelectAssignment = useCallback(
    (assignmentId: string) => {
      setSearchParams({ example: assignmentId });
    },
    [setSearchParams],
  );

  const toggleSidebar = useCallback(() => {
    const newParams = new URLSearchParams(searchParams);
    if (newParams.has('hideSidebar')) {
      newParams.delete('hideSidebar');
    } else {
      newParams.set('hideSidebar', 'true');
    }
    setSearchParams(newParams);
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    if (!SHOW_ASSIGNMENT_LIST) return; // the Escape shortcut only toggles a list that can be shown
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        toggleSidebar();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [toggleSidebar]);

  return (
    <div className="w-screen h-screen flex bg-white">
      {/* Left Sidebar - Navigation */}
      {!hideSidebar && (
        <div className="w-[250px] border-r border-gray-300 p-4 overflow-y-auto">
          <h2 className="text-lg font-semibold mb-4">Assignments</h2>
          <nav className="space-y-2">
            {assignments.map((assignment) => (
              <button
                key={assignment.id}
                onClick={() => handleSelectAssignment(assignment.id)}
                className={`w-full text-left px-3 py-2 rounded transition-colors ${
                  selectedAssignmentId === assignment.id ? 'font-bold bg-gray-100' : 'hover:bg-gray-50'
                }`}
              >
                {assignment.name}
              </button>
            ))}
          </nav>
        </div>
      )}

      {/* Right Content - Visualization */}
      <div className="flex-1 flex items-center justify-center overflow-auto">
        {SelectedComponent ? <SelectedComponent /> : <div>Example not found</div>}
      </div>
    </div>
  );
}

export default App;
