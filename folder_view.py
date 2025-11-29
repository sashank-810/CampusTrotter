import os

def generate_folder_plan(start_path):
    """
    Generates a multi-line string representing the folder structure
    starting from 'start_path'.
    
    Args:
        start_path (str): The absolute path to the root directory to scan.

    Returns:
        str: A string formatted to look like a directory tree.
    """
    plan_lines = []
    
    # Ensure the start_path is a normalized absolute path
    start_path = os.path.normpath(start_path)
    
    # We need to know the 'depth' of the starting path to calculate
    # the relative indentation for all subfolders.
    # We subtract 1 because we don't count the root level itself
    # as an indentation level.
    try:
        start_level = start_path.count(os.path.sep)
    except AttributeError:
        # Handle potential edge cases like empty paths
        return "Error: Invalid start path."

    for dirpath, dirnames, filenames in os.walk(start_path, topdown=True):
        try:
            # Calculate the current level of indentation
            current_level = dirpath.count(os.path.sep)
            relative_level = current_level - start_level
            
            # Create the indent string
            indent = "    " * relative_level
            
            # Get the name of the current directory
            dir_name = os.path.basename(dirpath)
            
            # Add the directory to the plan
            if dirpath == start_path:
                # The root directory gets a special prefix
                plan_lines.append(f"+ {dir_name}/")
            else:
                plan_lines.append(f"{indent}+ {dir_name}/")
            
            # Add all files in this directory
            file_indent = "    " * (relative_level + 1)
            for f in filenames:
                plan_lines.append(f"{file_indent}|-- {f}")
                
        except Exception as e:
            plan_lines.append(f"{indent}Error processing directory: {e}")
            
    return "\n".join(plan_lines)

# --- Main execution ---
if __name__ == "__main__":
    """
    This block runs when the script is executed directly.
    """
    try:
        # 1. Store the current directory
        # os.getcwd() gets the "current working directory"
        current_directory = os.getcwd()
        
        print(f"Current Directory: {current_directory}\n")
        
        # 2. Generate and store the plan
        print("Generating folder structure plan...")
        
        # The 'folder_plan' variable now stores the string
        folder_plan = generate_folder_plan(current_directory)
        
        # 3. Store the plan permanently in a file
        output_filename = "folder_plan.txt"
        with open(output_filename, "w", encoding="utf-8") as f:
            f.write(f"Folder Structure Plan for: {current_directory}\n")
            f.write("=" * 40 + "\n")
            f.write(folder_plan)
            
        print(f"\nSuccess! Folder plan has been stored in '{output_filename}'")
        
        # 4. (Optional) Also print the plan to the console for review
        print("\n--- Folder Plan Preview ---")
        print(folder_plan)
        print("---------------------------")

    except Exception as e:
        print(f"An unexpected error occurred: {e}")
    